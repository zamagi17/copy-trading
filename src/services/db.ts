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

      this.pool.on('error', (err: any) => {
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
            processed_order_keys JSONB DEFAULT '[]'::jsonb,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          ALTER TABLE virtual_state ADD COLUMN IF NOT EXISTS processed_order_keys JSONB DEFAULT '[]'::jsonb;
          ALTER TABLE virtual_state ADD COLUMN IF NOT EXISTS is_holiday_aborted BOOLEAN DEFAULT FALSE;
          ALTER TABLE virtual_state ADD COLUMN IF NOT EXISTS holiday_aborted_reason TEXT DEFAULT '';
          ALTER TABLE virtual_state ADD COLUMN IF NOT EXISTS holiday_aborted_at BIGINT DEFAULT 0;
          ALTER TABLE virtual_state ADD COLUMN IF NOT EXISTS is_schedule_aborted BOOLEAN DEFAULT FALSE;
          ALTER TABLE virtual_state ADD COLUMN IF NOT EXISTS schedule_aborted_reason TEXT DEFAULT '';
          ALTER TABLE virtual_state ADD COLUMN IF NOT EXISTS schedule_aborted_at BIGINT DEFAULT 0;
          ALTER TABLE virtual_state ADD COLUMN IF NOT EXISTS last_leader_detail JSONB DEFAULT NULL;
          ALTER TABLE virtual_state ADD COLUMN IF NOT EXISTS last_user_balance JSONB DEFAULT NULL;
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

        // Rekonsiliasi dua arah cerdas antara PostgreSQL dan File JSON lokal
        await this.reconcileStorage(client);
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

  /**
   * Rekonsiliasi Dua Arah Cerdas (PostgreSQL <-> File JSON):
   * Mencegah "data pincang" jika salah satu penyimpanan sempat offline atau diedit manual.
   */
  private async reconcileStorage(client: any) {
    try {
      // 1. REKONSILIASI KONFIGURASI (app_config)
      const cfgRes = await client.query('SELECT config, updated_at FROM app_config WHERE id = 1;');
      const fileMtimeCfg = fs.existsSync(CONFIG_PATH) ? fs.statSync(CONFIG_PATH).mtimeMs : 0;

      if (cfgRes.rows.length === 0 && fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        await client.query(
          'INSERT INTO app_config (id, config, updated_at) VALUES (1, $1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING;',
          [JSON.stringify(parsed)]
        );
        console.log('[Database] 📦 Migrasi config.json ke PostgreSQL selesai.');
      } else if (cfgRes.rows.length > 0 && fs.existsSync(CONFIG_PATH)) {
        const dbUpdated = cfgRes.rows[0].updated_at ? new Date(cfgRes.rows[0].updated_at).getTime() : 0;
        // Jika config.json diedit manual di disk lebih baru dari DB (>2 detik):
        if (fileMtimeCfg > dbUpdated + 2000) {
          try {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            await client.query(
              'UPDATE app_config SET config = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;',
              [JSON.stringify(parsed)]
            );
            console.log('[Database] 🔄 config.json diedit secara lokal. Konfigurasi disinkronkan ke PostgreSQL.');
          } catch {}
        } else {
          // DB lebih baru: sinkronkan ke file lokal
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgRes.rows[0].config, null, 2), 'utf-8');
        }
      }

      // 2. REKONSILIASI VIRTUAL STATE (virtual_state)
      const vsRes = await client.query('SELECT * FROM virtual_state WHERE id = 1;');
      const fileMtimeVs = fs.existsSync(VIRTUAL_STATE_PATH) ? fs.statSync(VIRTUAL_STATE_PATH).mtimeMs : 0;
      let localVsData: any = null;
      if (fs.existsSync(VIRTUAL_STATE_PATH)) {
        try {
          localVsData = JSON.parse(fs.readFileSync(VIRTUAL_STATE_PATH, 'utf-8'));
        } catch {}
      }

      if (vsRes.rows.length === 0 && localVsData) {
        await client.query(
          `INSERT INTO virtual_state (id, virtual_wallet_balance, virtual_positions, stream_leader_positions, position_avg_counts, last_processed_order_time, processed_order_keys, updated_at)
           VALUES (1, $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING;`,
          [
            localVsData.virtualWalletBalance ?? 100,
            JSON.stringify(localVsData.virtualPositions || []),
            JSON.stringify(localVsData.streamLeaderPositions || []),
            JSON.stringify(localVsData.positionAvgCounts || []),
            localVsData.lastProcessedOrderTime || 0,
            JSON.stringify(localVsData.processedOrderKeys || []),
          ]
        );
        console.log('[Database] 📦 Migrasi virtual_state.json ke PostgreSQL selesai.');
      } else if (vsRes.rows.length > 0 && localVsData) {
        const row = vsRes.rows[0];
        const dbUpdated = row.updated_at ? new Date(row.updated_at).getTime() : 0;
        const localOrderTime = Number(localVsData.lastProcessedOrderTime || 0);
        const dbOrderTime = Number(row.last_processed_order_time || 0);

        if (localOrderTime > dbOrderTime || fileMtimeVs > dbUpdated + 2000) {
          await client.query(
            `UPDATE virtual_state SET
               virtual_wallet_balance = $1,
               virtual_positions = $2,
               stream_leader_positions = $3,
               position_avg_counts = $4,
               last_processed_order_time = $5,
               processed_order_keys = $6,
               updated_at = CURRENT_TIMESTAMP
             WHERE id = 1;`,
            [
              localVsData.virtualWalletBalance ?? 100,
              JSON.stringify(localVsData.virtualPositions || []),
              JSON.stringify(localVsData.streamLeaderPositions || []),
              JSON.stringify(localVsData.positionAvgCounts || []),
              Math.max(localOrderTime, dbOrderTime),
              JSON.stringify(localVsData.processedOrderKeys || []),
            ]
          );
          console.log('[Database] 🔄 virtual_state.json lebih baru. Disinkronkan ke PostgreSQL.');
        } else {
          const freshData = {
            virtualWalletBalance: Number(row.virtual_wallet_balance || 100),
            virtualPositions: row.virtual_positions || [],
            streamLeaderPositions: row.stream_leader_positions || [],
            positionAvgCounts: row.position_avg_counts || [],
            lastProcessedOrderTime: Number(row.last_processed_order_time || 0),
            processedOrderKeys: Array.isArray(row.processed_order_keys) ? row.processed_order_keys : [],
          };
          fs.writeFileSync(VIRTUAL_STATE_PATH, JSON.stringify(freshData, null, 2), 'utf-8');
        }
      }

      // 3. REKONSILIASI RIWAYAT TRADE (trade_history - Merge by UUID)
      let localTrades: ClosedTrade[] = [];
      if (fs.existsSync(TRADE_HISTORY_PATH)) {
        try {
          const raw = fs.readFileSync(TRADE_HISTORY_PATH, 'utf-8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) localTrades = parsed;
        } catch {}
      }

      if (localTrades.length > 0) {
        for (const t of localTrades) {
          if (!t.id) continue;
          await client.query(
            `INSERT INTO trade_history (id, symbol, position_side, action, qty, entry_price, close_price, realized_pnl, pnl_pct, timestamp, closed_at, is_paper)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (id) DO NOTHING;`,
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
      }

      const combinedRes = await client.query(
        `SELECT id, symbol, position_side AS "positionSide", action,
                qty::numeric AS qty, entry_price::numeric AS "entryPrice",
                close_price::numeric AS "closePrice", realized_pnl::numeric AS "realizedPnl",
                pnl_pct::numeric AS "pnlPct", timestamp, closed_at AS "closedAt", is_paper AS "isPaper"
         FROM trade_history
         ORDER BY timestamp DESC
         LIMIT 250;`
      );
      if (combinedRes.rows.length > 0) {
        const mergedList = combinedRes.rows.map((r: any) => ({
          ...r,
          qty: Number(r.qty),
          entryPrice: Number(r.entryPrice),
          closePrice: Number(r.closePrice),
          realizedPnl: Number(r.realizedPnl),
          pnlPct: Number(r.pnlPct),
          timestamp: Number(r.timestamp),
          isPaper: Boolean(r.isPaper),
        }));
        fs.writeFileSync(TRADE_HISTORY_PATH, JSON.stringify(mergedList, null, 2), 'utf-8');
      }
    } catch (e: any) {
      console.warn('[Database] Catatan rekonsiliasi data:', e.message);
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
            processedOrderKeys: Array.isArray(row.processed_order_keys) ? row.processed_order_keys : [],
            isHolidayAborted: Boolean(row.is_holiday_aborted),
            holidayAbortedReason: row.holiday_aborted_reason || '',
            holidayAbortedAt: Number(row.holiday_aborted_at || 0),
            isScheduleAborted: Boolean(row.is_schedule_aborted),
            scheduleAbortedReason: row.schedule_aborted_reason || '',
            scheduleAbortedAt: Number(row.schedule_aborted_at || 0),
            lastLeaderDetail: row.last_leader_detail || null,
            lastUserBalance: row.last_user_balance || null,
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
    processedOrderKeys?: string[];
    isHolidayAborted?: boolean;
    holidayAbortedReason?: string;
    holidayAbortedAt?: number;
    isScheduleAborted?: boolean;
    scheduleAbortedReason?: string;
    scheduleAbortedAt?: number;
    lastLeaderDetail?: any;
    lastUserBalance?: any;
  }): Promise<void> {
    if (this.isConnected && this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO virtual_state (id, virtual_wallet_balance, virtual_positions, stream_leader_positions, position_avg_counts, last_processed_order_time, processed_order_keys, is_holiday_aborted, holiday_aborted_reason, holiday_aborted_at, is_schedule_aborted, schedule_aborted_reason, schedule_aborted_at, last_leader_detail, last_user_balance, updated_at)
           VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET
             virtual_wallet_balance = $1,
             virtual_positions = $2,
             stream_leader_positions = $3,
             position_avg_counts = $4,
             last_processed_order_time = $5,
             processed_order_keys = $6,
             is_holiday_aborted = $7,
             holiday_aborted_reason = $8,
             holiday_aborted_at = $9,
             is_schedule_aborted = $10,
             schedule_aborted_reason = $11,
             schedule_aborted_at = $12,
             last_leader_detail = COALESCE($13, virtual_state.last_leader_detail),
             last_user_balance = COALESCE($14, virtual_state.last_user_balance),
             updated_at = CURRENT_TIMESTAMP;`,
          [
            data.virtualWalletBalance,
            JSON.stringify(data.virtualPositions),
            JSON.stringify(data.streamLeaderPositions),
            JSON.stringify(data.positionAvgCounts),
            data.lastProcessedOrderTime,
            JSON.stringify(data.processedOrderKeys || []),
            Boolean(data.isHolidayAborted),
            data.holidayAbortedReason || '',
            Number(data.holidayAbortedAt || 0),
            Boolean(data.isScheduleAborted),
            data.scheduleAbortedReason || '',
            Number(data.scheduleAbortedAt || 0),
            data.lastLeaderDetail ? JSON.stringify(data.lastLeaderDetail) : null,
            data.lastUserBalance ? JSON.stringify(data.lastUserBalance) : null,
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
          `INSERT INTO virtual_state (id, virtual_wallet_balance, virtual_positions, stream_leader_positions, position_avg_counts, last_processed_order_time, processed_order_keys, updated_at)
           VALUES (1, $1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0, '[]'::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET
             virtual_wallet_balance = $1,
             virtual_positions = '[]'::jsonb,
             stream_leader_positions = '[]'::jsonb,
             position_avg_counts = '[]'::jsonb,
             last_processed_order_time = 0,
             processed_order_keys = '[]'::jsonb,
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
