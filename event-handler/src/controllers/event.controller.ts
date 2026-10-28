import { Request, Response } from 'express';
import { createApiRoot } from '../client/commercetools/create.client';
import CustomError from '../errors/custom.error';
import { logger } from '../utils/logger.utils';
import PubSubValidator from '../utils/validate_requests.utils';
import IngridApiClient from '../client/ingrid/ingrid.client';
import { readConfiguration } from '../utils/config.utils';
import type { IngridCompleteSessionRequestPayload } from '../client/ingrid/types/ingrid.client.type';
import { DecodedMessageType } from '../types/index.types';
import {
  changeShipmentState,
  setTransportOrderId,
} from '../client/commercetools/update.client';
import { SHIPMENT_STATE } from '../client/commercetools/types/commercetools.client.type';
import type { IngridCompleteSessionResponse } from '../client/ingrid/types/ingrid.client.type';
/**
 * Exposed event POST endpoint.
 * Receives the Pub/Sub message and works with it
 *
 * @param {Request} request The express request
 * @param {Response} response The express response
 * @returns
 */
export const post = async (request: Request, response: Response) => {
  const body = PubSubValidator.validateRequestBody(request);
  const message = PubSubValidator.validateMessageFormat(body);
  const decodedData =
    PubSubValidator.decodeMessageData<DecodedMessageType>(message);

  const orderId = PubSubValidator.validateDecodedMessage(decodedData);
  if (orderId === 'RESOURCE_CREATED_MESSAGE') {
    const loggingMessage =
      'Message for subscription created. Skip processing message.';
    logger.info(loggingMessage);
    return response.status(202).send(loggingMessage);
  }
  logger.info(
    `processing shipping session completion for order ID : ${orderId}`
  );

  let commercetoolsOrder;
  try {
    commercetoolsOrder = await createApiRoot()
      .orders()
      .withId({ ID: orderId })
      .get({
        queryArgs: {
          expand: 'cart',
        },
      })
      .execute()
      .then((res) => res.body);
  } catch (error) {
    throw new CustomError(
      502,
      `Failed to fetch order ${orderId} from commercetools. ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error instanceof Error ? error : new Error(String(error)),
      }
    );
  }

  if (
    commercetoolsOrder.shipmentState === SHIPMENT_STATE.READY ||
    commercetoolsOrder.shipmentState === SHIPMENT_STATE.CANCELED
  ) {
    // This message may be a Pub/Sub redelivery of one already processed (Pub/Sub is
    // at-least-once) - a prior invocation already reached a terminal shipment state, so
    // reprocessing would at best repeat work and at worst race the already-committed result.
    const loggingMessage = `Shipment state for order ID ${orderId} is already ${commercetoolsOrder.shipmentState}, skipping reprocessing.`;
    logger.info(loggingMessage);
    return response.status(204).send({
      orderId,
      shipmentState: commercetoolsOrder.shipmentState,
    });
  }

  const ingridSessionId =
    commercetoolsOrder.cart?.obj?.custom?.fields?.ingridSessionId;

  if (!ingridSessionId) {
    throw new CustomError(
      202,
      ` Ingrid session ID not found for the order with ID ${commercetoolsOrder.id}.`
    );
  }

  const apiSecret = readConfiguration().ingridApiKey;
  const environment = readConfiguration().ingridEnvironment;

  const ingridOpts = {
    apiSecret,
    environment,
  };

  const ingridClient = new IngridApiClient(ingridOpts);

  const payLoad: IngridCompleteSessionRequestPayload = {
    checkout_session_id: ingridSessionId,
    external_id: commercetoolsOrder.orderNumber,
  };

  let ingridResponse: IngridCompleteSessionResponse | undefined = undefined;
  let completeCheckoutSessionError: Error | undefined = undefined;

  try {
    ingridResponse = await ingridClient.completeCheckoutSession(payLoad);
  } catch (error) {
    if (error instanceof CustomError) {
      logger.error(
        `Error while completing ingrid session for order ID ${orderId}: ${error.message}`
      );
    }
    completeCheckoutSessionError = error as Error;

    // The complete call can fail locally (e.g. a timeout) or be rejected (e.g. a 409)
    // while Ingrid actually already completed the session - check the session's real
    // status before deciding the completion failed and cancelling the order's shipment.
    try {
      const sessionResponse =
        await ingridClient.getCheckoutSession(ingridSessionId);
      if (sessionResponse.session.status === 'COMPLETE') {
        logger.info(
          `Ingrid session ${ingridSessionId} for order ID ${orderId} is already COMPLETE despite the completion error, proceeding as successful.`
        );
        ingridResponse = sessionResponse;
        completeCheckoutSessionError = undefined;
      }
    } catch (lookupError) {
      logger.error(
        `Failed to verify Ingrid session status for order ID ${orderId} after completion error: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`
      );
    }
  }

  if (ingridResponse) {
    const transportOrderId = ingridResponse.session.delivery_groups[0]?.tos_id;
    const existingTransportOrderId = commercetoolsOrder.shippingCustomFields
      ?.fields?.ingridTransportOrderId as string | undefined;
    let updatedCommercetoolsOrder;
    if (transportOrderId) {
      logger.info(
        `Update transport order ID for the order ID ${commercetoolsOrder.id}: ${transportOrderId}.`
      );
      updatedCommercetoolsOrder = await setTransportOrderId(
        readConfiguration().ingridShippingCustomTypeKey,
        orderId,
        commercetoolsOrder.version,
        transportOrderId
      );
    }

    if (
      ingridResponse.session.status === 'COMPLETE' &&
      !transportOrderId &&
      !existingTransportOrderId
    ) {
      // Ingrid reports the session as COMPLETE but hasn't produced a transport order ID yet -
      // marking the shipment Ready now would leave the order without one, and it isn't a
      // permanent failure either since the session did complete, so ask for a retry instead
      // (e.g. a redelivered message) once the transport order ID becomes available.
      throw new CustomError(
        502,
        `Ingrid session ${ingridSessionId} for order ID ${orderId} is COMPLETE but has no transport order ID yet.`
      );
    }

    if (ingridResponse.session.status === 'COMPLETE') {
      const updateOrderResult = await changeShipmentState(
        orderId,
        updatedCommercetoolsOrder
          ? updatedCommercetoolsOrder.version
          : commercetoolsOrder.version,
        SHIPMENT_STATE.READY
      );
      logger.info(
        `complete ingrid session successfully with transport order ID ${transportOrderId ?? existingTransportOrderId}: ${JSON.stringify(ingridResponse)}`
      );
      logger.info(
        `Update commercetools cart shipment state as ready. (orderId: ${updateOrderResult.id})`
      );
    } else {
      const updateOrderResult = await changeShipmentState(
        orderId,
        updatedCommercetoolsOrder
          ? updatedCommercetoolsOrder.version
          : commercetoolsOrder.version,
        SHIPMENT_STATE.CANCELED
      );
      logger.info(
        `complete ingrid session failed with transport order ID ${transportOrderId}: ${JSON.stringify(ingridResponse)}`
      );
      logger.info(
        `Update commercetools cart shipment state as canceled. (orderId: ${updateOrderResult.id})`
      );
    }
    return response.status(204).send({
      ingridSessionId: ingridResponse.session.checkout_session_id,
      status: ingridResponse.session.status,
    });
  }

  // A retryable failure (network error/timeout or Ingrid 5xx) leaves the
  // shipment state untouched so a redelivered message can still complete it;
  // anything else (e.g. a bad session ID) is a permanent failure, so cancel.
  const isRetryable =
    completeCheckoutSessionError instanceof CustomError &&
    completeCheckoutSessionError.statusCode === 502;

  if (!isRetryable) {
    const updateOrderResult = await changeShipmentState(
      orderId,
      commercetoolsOrder.version,
      SHIPMENT_STATE.CANCELED
    );
    logger.info(
      `complete ingrid session failed: ${completeCheckoutSessionError?.message}`
    );
    logger.info(
      `Update commercetools cart shipment state as canceled. (orderId: ${updateOrderResult.id})`
    );
  }
  throw completeCheckoutSessionError;
};
