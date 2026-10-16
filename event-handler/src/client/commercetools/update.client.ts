import { createApiRoot } from './create.client';
import CustomError from '../../errors/custom.error';

const isConcurrentModificationError = (error: unknown): boolean =>
  (error as { statusCode?: number })?.statusCode === 409;

/**
 * Runs an order write, and if it fails because the order was concurrently modified (409),
 * re-fetches the latest order version and retries.
 *
 * @remarks
 * This matters here because this service can be invoked more than once for the same order
 * (Pub/Sub redelivers an `OrderCreated` message at-least-once), so two invocations can race on
 * the same order's version. If all attempts are exhausted, the error is wrapped as a retryable
 * `CustomError` so the caller fails the request instead of letting it be silently acknowledged.
 *
 * @param orderId - The ID of the order being written to, used to refetch its latest version
 * @param orderVersion - The order version the first attempt should use
 * @param write - Performs the write for a given order version
 */
const updateOrderWithConcurrencyRetry = async <T>(
  orderId: string,
  orderVersion: number,
  write: (orderVersion: number) => Promise<T>,
  maxAttempts = 3
): Promise<T> => {
  let version = orderVersion;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await write(version);
    } catch (error) {
      if (!isConcurrentModificationError(error) || attempt === maxAttempts) {
        throw new CustomError(
          502,
          `Failed to update order "${orderId}". ${error instanceof Error ? error.message : String(error)}`,
          { cause: error instanceof Error ? error : new Error(String(error)) }
        );
      }
      version = await createApiRoot()
        .orders()
        .withId({ ID: orderId })
        .get()
        .execute()
        .then((res) => res.body.version);
    }
  }
  /* istanbul ignore next -- unreachable: the loop above always returns or throws */
  throw new CustomError(
    502,
    `Failed to update order "${orderId}" after ${maxAttempts} attempts due to concurrent modification.`
  );
};

export const changeShipmentState = async (
  orderId: string,
  orderVersion: number,
  state: string
) =>
  updateOrderWithConcurrencyRetry(orderId, orderVersion, (version) =>
    createApiRoot()
      .orders()
      .withId({ ID: orderId })
      .post({
        body: {
          version,
          actions: [
            {
              action: 'changeShipmentState',
              shipmentState: state,
            },
          ],
        },
      })
      .execute()
      .then((res) => res.body)
  );

export const setTransportOrderId = async (
  shipingCustomTypeKey: string,
  orderId: string,
  orderVersion: number,
  transportOrderId: string
) => {
  const type = await createApiRoot()
    .types()
    .withKey({ key: shipingCustomTypeKey })
    .get()
    .execute()
    .then((res) => res.body);

  return updateOrderWithConcurrencyRetry(orderId, orderVersion, (version) =>
    createApiRoot()
      .orders()
      .withId({ ID: orderId })
      .post({
        body: {
          version,
          actions: [
            {
              action: 'setShippingCustomType',
              type: {
                id: type.id,
                typeId: 'type',
              },
              fields: {
                ingridTransportOrderId: transportOrderId,
              },
            },
          ],
        },
      })
      .execute()
      .then((res) => res.body)
  );
};
