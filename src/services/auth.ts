import crypto from 'crypto';

export class AuthService {
  /**
   * Meng-hash password menggunakan SHA-256 dengan salt
   */
  static hashPassword(password: string, salt: string = 'copytrader_salt'): string {
    return crypto.createHmac('sha256', salt).update(password).digest('hex');
  }

  /**
   * Membuat JSON Web Token (JWT) standar menggunakan crypto bawaan
   */
  static generateToken(payload: any, secret: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    // Token aktif selama 7 hari
    const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  /**
   * Memvalidasi JWT token
   */
  static verifyToken(token: string, secret: string): any {
    try {
      if (!token || typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const [header, body, signature] = parts;
      const expectedSig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');

      if (signature !== expectedSig) return null;

      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
      if (payload.exp && Date.now() > payload.exp) {
        return null; // Token kedaluwarsa
      }

      return payload;
    } catch {
      return null;
    }
  }
}
