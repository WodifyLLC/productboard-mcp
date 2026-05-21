import { AuthHeaders } from './types.js';
import { ProductboardAPIError } from '@api/errors.js';
import axios, { AxiosError } from 'axios';
import { Logger } from '@utils/logger.js';
import { LogLevel } from '@utils/types.js';

export class BearerTokenAuth {
  // private readonly baseUrl: string;
  private readonly logger: Logger;

  constructor(_baseUrl: string) {
    // this.baseUrl = baseUrl;
    // Respect the configured LOG_LEVEL instead of hardcoding 'debug'.
    // Wodify patch: prevents this internal logger from emitting at debug level
    // (which previously logged the Authorization header on every call).
    const envLevel = (process.env.LOG_LEVEL as LogLevel | undefined);
    this.logger = new Logger({ level: envLevel || 'error', name: 'bearer-auth' });
  }

  async validateToken(token: string): Promise<boolean> {
    // Wodify patch: removed the NODE_ENV === "development" bypass — it was a
    // silent way to disable auth validation just by setting an env var, and
    // the upstream .env.example ships with NODE_ENV=development. The explicit
    // SKIP_TOKEN_VALIDATION flag is retained for intentional opt-out.
    if (process.env.SKIP_TOKEN_VALIDATION === "true") {
      this.logger.warn("SKIP_TOKEN_VALIDATION=true — bypassing bearer token validation");
      return true;
    }

    try {
      const url = "https://api.productboard.com/v2/entities?type[]=feature";
      this.logger.debug('Bearer token validation URL', { url });
      // Wodify patch: do NOT log the Authorization header — it contains the
      // bearer token in plaintext.

      // Use /features endpoint for token validation (without parameters)
      const response = await axios.get(url, {
        headers: this.getHeaders(token),
        timeout: 5000,
      });

      this.logger.debug('Token validation successful', { status: response.status });
      return response.status === 200;
    } catch (error) {
      if (error instanceof AxiosError) {
        this.logger.error('Token validation failed', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
        });
        
        if (error.response?.status === 401) {
          throw new ProductboardAPIError('Invalid API token', 'INVALID_TOKEN', undefined, 401);
        }
        
        if (error.response?.status === 403) {
          throw new ProductboardAPIError('API token lacks required permissions', 'INSUFFICIENT_PERMISSIONS', undefined, 403);
        }
      }
      
      this.logger.error('Token validation error', { error: error instanceof Error ? error.message : error });
      return false;
    }
  }

  getHeaders(token: string): AuthHeaders {
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }
}
