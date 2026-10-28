import axios, { AxiosInstance } from 'axios';
import {
  IngridBasePath,
  type IngridCompleteSessionRequestPayload,
  type IngridCompleteSessionResponse,
  type IngridGetSessionResponse,
  IngridUrls,
} from './types/ingrid.client.type';
import CustomError from '../../errors/custom.error';
import { logger } from '../../utils/logger.utils';

const logIngridErrorResponse = (error: unknown, url: string): void => {
  if (axios.isAxiosError(error) && error.response) {
    logger.error(
      `Ingrid API responded with status ${error.response.status} for ${url}: ${JSON.stringify(error.response.data)}`
    );
  }
};

export default class IngridApiClient {
  public client: AxiosInstance;

  constructor(opts: {
    apiSecret: string;
    environment: keyof typeof IngridBasePath;
  }) {
    this.client = createClient(opts);
  }

  public async completeCheckoutSession(
    payload: IngridCompleteSessionRequestPayload
  ) {
    try {
      const response = await this.client.post(
        IngridUrls.DELIVERY_CHECKOUT + '/session.complete',
        payload
      );
      return response.data as IngridCompleteSessionResponse;
    } catch (error: unknown) {
      logIngridErrorResponse(
        error,
        IngridUrls.DELIVERY_CHECKOUT + '/session.complete'
      );

      // No response (network error/timeout) or a 5xx from Ingrid is transient
      // and should be retried; a 4xx means the request itself is bad and
      // retrying won't help.
      const isRetryable =
        axios.isAxiosError(error) &&
        (!error.response || error.response.status >= 500);

      throw new CustomError(
        isRetryable ? 502 : 202,
        `Failed to complete session on Ingrid. ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error instanceof Error ? error : new Error(String(error)),
        }
      );
    }
  }

  /**
   * Retrieves a checkout session from Ingrid without completing it.
   *
   * @remarks
   * Used to check a session's actual status after a `completeCheckoutSession` call errored
   * (e.g. a 409 or a timeout), since Ingrid may have already completed the session even though
   * the response was never received or was rejected as a duplicate.
   *
   * @see {@link https://developer.ingrid.com/delivery_checkout/backend_integration/#get-checkout-session}
   */
  public async getCheckoutSession(
    checkoutSessionId: string
  ): Promise<IngridGetSessionResponse> {
    try {
      const response = await this.client.get(
        IngridUrls.DELIVERY_CHECKOUT +
          `/session.get?checkout_session_id=${checkoutSessionId}`
      );
      return response.data as IngridGetSessionResponse;
    } catch (error: unknown) {
      logIngridErrorResponse(
        error,
        IngridUrls.DELIVERY_CHECKOUT +
          `/session.get?checkout_session_id=${checkoutSessionId}`
      );

      const isRetryable =
        axios.isAxiosError(error) &&
        (!error.response || error.response.status >= 500);

      throw new CustomError(
        isRetryable ? 502 : 202,
        `Failed to get session from Ingrid. ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error instanceof Error ? error : new Error(String(error)),
        }
      );
    }
  }
}

const createClient = (opts: {
  apiSecret: string;
  environment: keyof typeof IngridBasePath;
}): AxiosInstance => {
  return axios.create({
    baseURL: IngridBasePath[opts.environment],
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${opts.apiSecret}`,
    },
    maxRedirects: 20,
  });
};
