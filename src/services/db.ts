import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { AppConfig, ClosedTrade } from '../types';

dotenv.config();

const CONFIG_PATH = path.resolve(__dirname, '../../config.json');
const VIRTUAL_STATE_PATH = path.resolve(__dirname, '../../virtual_state.json');
const TRADE_HISTORY_PATH = path.resolve(__dirname, '../../trade_history.json');

export class DatabaseService {
  private pool: Pool | null = null;
  public isConnected: boolean = false;
  private dbTargetInfo: string = '';

  constructor() {
    try {
      const poolConfig = process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {
            host: process.env.DB_HOST || '127.0.0.1',
            port: parseInt(process.env.DB_PORT || '5433', 10),
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || '123456',
            database: process.env.DB_NAME || 'copytrading',
          };

      this.dbTargetInfo = process.env.DATABASE_URL
        ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@')
        : `${(poolConfig as any).user}@${(poolConfig as any).host}:${(poolConfig as any).port}/${(poolConfig as any).database}`;

      this.pool = new Pool({
        ...poolConfig,
        connectionTimeoutMillis: 4000,
        idleTimeoutMillis: 30000,
        max: 10,
      });

      this.pool.on('error', (err) => {
        console.error('[Database] Idle client error:', err.message);
      });
    } catch (e: any) {
      console.warn('[Database] Gagal inisialisasi connection pool:', e.message);
      this.pool = null;
    }
  }

  /**
   * Inisialisasi koneksi & auto-create tabel jika belum ada
   */
  async init(): Promise<boolean> {
    if (!this.pool) return false;

    try {
      const client = await this.pool.connect();
      try {
        // 1. Tabel Konfigurasi Bot
        await client.query(`
          CREATE TABLE IF NOT EXISTS app_config (
            id INT PRIMARY KEY DEFAULT 1,
            config JSONB NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // 2. Tabel State Posisi & Saldo Virtual
        await client.query(`
          CREATE TABLE IF NOT EXISTS virtual_state (
            id INT PRIMARY KEY DEFAULT 1,
            virtual_wallet_balance NUMERIC DEFAULT 100,
            virtual_positions JSONB DEFAULT '[]'::jsonb,
            stream_leader_positions JSONB DEFAULT '[]'::jsonb,
            position_avg_counts JSONB DEFAULT '[]'::jsonb,
            last_processed_order_time BIGINT DEFAULT 0,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // 3. Tabel Riwayat Transaksi Selesai
        await client.query(`
          CREATE TABLE IF NOT EXISTS trade_history (
            id VARCHAR(64) PRIMARY KEY,
            symbol VARCHAR(32) NOT NULL,
            position_side VARCHAR(16) NOT NULL,
            action VARCHAR(32) NOT NULL,
            qty NUMERIC NOT NULL,
            entry_price NUMERIC NOT NULL,
            close_price NUMERIC NOT NULL,
            realized_pnl NUMERIC NOT NULL,
            pnl_pct NUMERIC NOT NULL,
            timestamp BIGINT NOT NULL,
            closed_at VARCHAR(64) NOT NULL,
            is_paper BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_trade_history_timestamp ON trade_history (timestamp DESC);
        `);

        this.isConnected = true;
        console.log(`[Database] ✅ Terhubung ke PostgreSQL: ${this.dbTargetInfo}`);

        // Migrasi data awal dari JSON jika tabel masih kosong
        await this.migrateInitialData(client);
        return true;
      } finally {
        client.release();
      }
    } catch (err: any) {
      this.isConnected = false;
      console.warn(`[Database] ⚠️ Tidak dapat terhubung ke PostgreSQL (${err.message}). Menggunakan penyimpanan lokal JSON sebagai fallback.`);
      return false;
    }
  }

  private async migrateInitialData(client: any) {
    try {
      // Migrasi Config dari config.json jika DB kosong
      const cfgRes = await client.query('SELECT COUNT(*) FROM app_config WHERE id = 1;');
      if (parseInt(cfgRes.rows[0].count) === 0 && fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        await client.query(
          'INSERT INTO app_config (id, config) VALUES (1, $1) ON CONFLICT (id) DO NOTHING;',
          [JSON.stringify(parsed)]
        );
        console.log('[Database] 📦 Migrasi config.json ke PostgreSQL selesai.');
      }

      // Migrasi Virtual State jika DB kosong
      const vsRes = await client.query('SELECT COUNT(*) FROM virtual_state WHERE id = 1;');
      if (parseInt(vsRes.rows[0].count) === 0 && fs.existsSync(VIRTUAL_STATE_PATH)) {
        const raw = fs.readFileSync(VIRTUAL_STATE_PATH, 'utf-8');
        const data = JSON.parse(raw);
        await client.query(
          `INSERT INTO virtual_state (id, virtual_wallet_balance, virtual_positions, stream_leader_positions, position_avg_counts, last_processed_order_time)
           VALUES (1, $1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING;`,
          [
            data.virtualWalletBalance ?? 100,
            JSON.stringify(data.virtualPositions || []),
            JSON.stringify(data.streamLeaderPositions || []),
            JSON.stringify(data.positionAvgCounts || []),
            data.lastProcessedOrderTime || 0,
          ]
        );
        console.log('[Database] 📦 Migrasi virtual_state.json ke PostgreSQL selesai.');
      }

      // Migrasi Trade History jika DB kosong
      const thRes = await client.query('SELECT COUNT(*) FROM trade_history;');
      if (parseInt(thRes.rows[0].count) === 0 && fs.existsSync(TRADE_HISTORY_PATH)) {
        const raw = fs.readFileSync(TRADE_HISTORY_PATH, 'utf-8');
        const trades = JSON.parse(raw);
        if (Array.isArray(trades) && trades.length > 0) {
          for (const t of trades) {
            await client.query(
              `INSERT INTO trade_history (id, symbol, position_side, action, qty, entry_price, close_price, realized_pnl, pnl_pct, timestamp, closed_at, is_paper)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING;`,
              [
                t.id,
                t.symbol,
                t.positionSide,
                t.action,
                t.qty,
                t.entryPrice,
                t.closePrice,
                t.realizedPnl,
                t.pnlPct,
                t.timestamp,
                t.closedAt,
                Boolean(t.isPaper),
              ]
            );
          }
          console.log(`[Database] 📦 Migrasi ${trades.length} riwayat trade ke PostgreSQL selesai.`);
        }
      }
    } catch (e: any) {
      console.warn('[Database] Catatan migrasi awal:', e.message);
    }
  }

  // ==========================================
  // CONFIG CRUD
  // ==========================================
  async loadConfig(): Promise<AppConfig | null> {
    if (this.isConnected && this.pool) {
      try {
        const res = await this.pool.query('SELECT config FROM app_config WHERE id = 1;');
        if (res.rows.length > 0 && res.rows[0].config) {
          return res.rows[0].config as AppConfig;
        }
      } catch (e: any) {
        console.warn('[Database] Gagal baca config dari DB, fallback JSON:', e.message);
      }
    }
    return null;
  }

  async saveConfig(config: AppConfig): Promise<void> {
    if (this.isConnected && this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO app_config (id, config, updated_at)
           VALUES (1, $1, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET config = $1, updated_at = CURRENT_TIMESTAMP;`,
          [JSON.stringify(config)]
        );
      } catch (e: any) {
        console.error('[Database] Gagal simpan config ke DB:', e.message);
      }
    }
  }

  // ==========================================
  // VIRTUAL STATE CRUD
  // ==========================================
  async loadVirtualState(): Promise<any | null> {
    if (this.isConnected && this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM virtual_state WHERE id = 1;');
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            virtualWalletBalance: Number(row.virtual_wallet_balance || 100),
            virtualPositions: row.virtual_positions || [],
            streamLeaderPositions: row.stream_leader_positions || [],
            positionAvgCounts: row.position_avg_counts || [],
            lastProcessedOrderTime: Number(row.last_processed_order_time || 0),
          };
        }
      } catch (e: any) {
        console.warn('[Database] Gagal baca virtual_state dari DB, fallback JSON:', e.message);
      }
    }
    return null;
  }

  async saveVirtualState(data: {
    virtualWalletBalance: number;
    virtualPositions: any[];
    streamLeaderPositions: any[];
    positionAvgCounts: any[];
    lastProcessedOrderTime: number;
  }): Promise<void> {
    if (this.isConnected && this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO virtual_state (id, virtual_wallet_balance, virtual_positions, stream_leader_positions, position_avg_counts, last_processed_order_time, updated_at)
           VALUES (1, $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET
             virtual_wallet_balance = $1,
             virtual_positions = $2,
             stream_leader_positions = $3,
             position_avg_counts = $4,
             last_processed_order_time = $5,
             updated_at = CURRENT_TIMESTAMP;`,
          [
            data.virtualWalletBalance,
            JSON.stringify(data.virtualPositions),
            JSON.stringify(data.streamLeaderPositions),
            JSON.stringify(data.positionAvgCounts),
            data.lastProcessedOrderTime,
          ]
        );
      } catch (e: any) {
        console.error('[Database] Gagal simpan virtual_state ke DB:', e.message);
      }
    }
  }

  async resetVirtualState(balance: number = 100): Promise<void> {
    if (this.isConnected && this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO virtual_state (id, virtual_wallet_balance, virtual_positions, stream_leader_positions, position_avg_counts, last_processed_order_time, updated_at)
           VALUES (1, $1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET
             virtual_wallet_balance = $1,
             virtual_positions = '[]'::jsonb,
             stream_leader_positions = '[]'::jsonb,
             position_avg_counts = '[]'::jsonb,
             last_processed_order_time = 0,
             updated_at = CURRENT_TIMESTAMP;`,
          [balance]
        );
      } catch (e: any) {
        console.error('[Database] Gagal reset virtual_state di DB:', e.message);
      }
    }
  }

  // ==========================================
  // TRADE HISTORY CRUD
  // ==========================================
  async loadTradeHistory(limit: number = 250): Promise<ClosedTrade[]> {
    if (this.isConnected && this.pool) {
      try {
        const res = await this.pool.query(
          `SELECT id, symbol, position_side AS "positionSide", action,
                  qty::numeric AS qty, entry_price::numeric AS "entryPrice",
                  close_price::numeric AS "closePrice", realized_pnl::numeric AS "realizedPnl",
                  pnl_pct::numeric AS "pnlPct", timestamp, closed_at AS "closedAt", is_paper AS "isPaper"
           FROM trade_history
           ORDER BY timestamp DESC
           LIMIT $1;`,
          [limit]
        );
        return res.rows.map((r: any) => ({
          ...r,
          qty: Number(r.qty),
          entryPrice: Number(r.entryPrice),
          closePrice: Number(r.closePrice),
          realizedPnl: Number(r.realizedPnl),
          pnlPct: Number(r.pnlPct),
          timestamp: Number(r.timestamp),
          isPaper: Boolean(r.isPaper),
        }));
      } catch (e: any) {
        console.warn('[Database] Gagal baca trade_history dari DB, fallback JSON:', e.message);
      }
    }
    return [];
  }

  async insertClosedTrade(trade: ClosedTrade): Promise<void> {
    if (this.isConnected && this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO trade_history (id, symbol, position_side, action, qty, entry_price, close_price, realized_pnl, pnl_pct, timestamp, closed_at, is_paper)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO NOTHING;`,
          [
            trade.id,
            trade.symbol,
            trade.positionSide,
            trade.action,
            trade.qty,
            trade.entryPrice,
            trade.closePrice,
            trade.realizedPnl,
            trade.pnlPct,
            trade.timestamp,
            trade.closedAt,
            trade.isPaper,
          ]
        );
      } catch (e: any) {
        console.error('[Database] Gagal simpan closed trade ke DB:', e.message);
      }
    }
  }

  async clearTradeHistory(): Promise<void> {
    if (this.isConnected && this.pool) {
      try {
        await this.pool.query('TRUNCATE TABLE trade_history;');
      } catch (e: any) {
        console.error('[Database] Gagal hapus riwayat trade dari DB:', e.message);
      }
    }
  }
}

export const dbService = new DatabaseService();
