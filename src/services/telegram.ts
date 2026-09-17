import axios from 'axios';
import { TelegramConfig } from '../types';

export class TelegramService {
  private config: TelegramConfig | null = null;

  configure(config?: TelegramConfig) {
    this.config = config || null;
  }

  /**
   * Mengirim pesan teks berformat HTML ke Telegram Chat ID pengguna
   */
  async sendMessage(text: string, overrideConfig?: TelegramConfig): Promise<boolean> {
    const cfg = overrideConfig || this.config;
    if (!cfg || !cfg.enabled || !cfg.botToken || !cfg.chatId) {
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
      const res = await axios.post(
        url,
        {
          chat_id: cfg.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        { timeout: 8000 }
      );
      return Boolean(res.data?.ok);
    } catch (err: any) {
      console.error('[TelegramService] Gagal kirim notifikasi HTML:', err.response?.data?.description || err.message);
      // Fallback: Jika Telegram gagal parse HTML entity (misal pesan error bursa mengandung tag/simbol < >), kirim sebagai plain text
      try {
        const plainText = text.replace(/<[^>]+>/g, '');
        const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
        const resFallback = await axios.post(
          url,
          {
            chat_id: cfg.chatId,
            text: plainText,
            disable_web_page_preview: true,
          },
          { timeout: 8000 }
        );
        return Boolean(resFallback.data?.ok);
      } catch {}
      return false;
    }
  }

  /**
   * Menguji koneksi bot Telegram dan Chat ID
   */
  async testConnection(
    botToken: string,
    chatId: string
  ): Promise<{ success: boolean; message: string; latencyMs?: number }> {
    if (!botToken || !chatId) {
      return { success: false, message: 'Bot Token dan Chat ID tidak boleh kosong!' };
    }

    const startTime = Date.now();
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const testMsg = `<b>🤖 BINANCE COPY TRADER NOTIFICATION TEST</b>\n\n` +
        `✅ <i>Koneksi Bot Telegram Berhasil Terhubung!</i>\n` +
        `⏰ Waktu: <code>${new Date().toLocaleString('id-ID')}</code>\n` +
        `💡 Notifikasi posisi buka/tutup, Take Profit, Cut Loss, dan alert sistem akan dikirimkan ke sini secara otomatis.`;

      const res = await axios.post(
        url,
        {
          chat_id: chatId,
          text: testMsg,
          parse_mode: 'HTML',
        },
        { timeout: 8000 }
      );

      const latencyMs = Date.now() - startTime;
      if (res.data?.ok) {
        return {
          success: true,
          message: 'Pesan tes berhasil terkirim ke Telegram Anda!',
          latencyMs,
        };
      } else {
        return {
          success: false,
          message: res.data?.description || 'Gagal mengirim pesan tes ke Telegram.',
        };
      }
    } catch (err: any) {
      const errMsg = err.response?.data?.description || err.message;
      return {
        success: false,
        message: `Koneksi Telegram Gagal: ${errMsg}`,
      };
    }
  }
}

export const telegramService = new TelegramService();
