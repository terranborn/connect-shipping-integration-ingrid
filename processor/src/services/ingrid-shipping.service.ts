import { CommercetoolsApiClient } from '../clients/commercetools/api.client';
import { IngridApiClient } from '../clients/ingrid/ingrid.client';
import { getCartIdFromContext } from '../libs/fastify/context';
import { appLogger } from '../libs/logger';
import { CustomError } from '../libs/fastify/errors';
import { AbstractShippingService } from './abstract-shipping.service';
import {
  deductShippingCostFromCartTotalPrice,
  transformCommercetoolsCartToIngridPayload,
  transformIngridDeliveryGroupsToCommercetoolsDataTypes,
} from './helpers';
import { getConfig } from '../config';
import type { Cart } from '@commercetools/platform-sdk';
import type { InitSessionResponse, UpdateSessionResponse } from './types/ingrid-shipping.type';
import {
  IngridGetSessionResponse,
  IngridUpdateSessionRequestPayload,
  IngridUpdateSessionResponse,
} from '../clients/ingrid/types/ingrid.client.type';

export class IngridShippingService extends AbstractShippingService {
  constructor(commercetoolsClient: CommercetoolsApiClient, ingridClient: IngridApiClient) {
    super(commercetoolsClient, ingridClient);
  }

  /**
   * Init Ingrid session
   *
   * @remarks
   * Implementation to initialize session in Ingrid platform.
   *
   * @returns {Promise<InitSessionResponse>} Returns the commercetools cart id, Ingrid session id and Ingrid checkout session html snippet
   */
  public async init(voucherCodes?: string[]): Promise<InitSessionResponse> {
    appLogger.info(`init Ingrid session with voucherCodes: ${voucherCodes}`);
    const ingridSessionCustomTypeKey = getConfig().keyOfIngridSessionCustomType;
    const customType = await this.commercetoolsClient.getCustomType(ingridSessionCustomTypeKey);

    if (!customType) {
      appLogger.error(
        `[ERROR]: Failed to get custom type on Ingrid session init with key "${ingridSessionCustomTypeKey}".`,
      );
      throw new CustomError({
        message: 'No Ingrid session custom type id found',
        code: 'NO_INGRID_SESSION_CUSTOM_TYPE_ID_FOUND',
        httpErrorStatus: 400,
      });
    }

    const ctCart = await this.commercetoolsClient.getCartById(getCartIdFromContext());
    const ingridSessionId = ctCart.custom?.fields?.ingridSessionId;
    const ingridCheckoutPayload = transformCommercetoolsCartToIngridPayload(ctCart, voucherCodes);

    const ingridCheckoutSession = ingridSessionId
      ? await this.refreshIngridSessionWithLatestVoucherCodes(ingridSessionId, voucherCodes)
      : await this.ingridClient.createCheckoutSession(ingridCheckoutPayload);

    const updatedCart = await this.updateCartWithIngridSessionId(
      ctCart,
      ingridCheckoutSession.session.checkout_session_id,
      customType.id,
    );

    appLogger.info(`[SUCCESS]: Ingrid session with ID ${ingridCheckoutSession.session.checkout_session_id} initiated.`);

    return {
      data: {
        success: true,
        cartVersion: updatedCart.version,
        ingridHtml: ingridCheckoutSession.html_snippet,
        ingridSessionId: ingridCheckoutSession.session.checkout_session_id,
      },
    };
  }

  private async refreshIngridSessionWithLatestVoucherCodes(
    ingridSessionId: string,
    voucherCodes?: string[],
  ): Promise<IngridGetSessionResponse | IngridUpdateSessionResponse> {
    let ingridCheckoutSession = await this.ingridClient.getCheckoutSession(ingridSessionId);
    const existingVoucherCodesInSession = ingridCheckoutSession.session.cart.vouchers;
    const isVoucherCodesUnchanged =
      (!existingVoucherCodesInSession && !voucherCodes) || // both are undefined or null are considered unchanged
      (Array.isArray(existingVoucherCodesInSession) &&
        Array.isArray(voucherCodes) &&
        existingVoucherCodesInSession.length === voucherCodes.length &&
        existingVoucherCodesInSession
          .slice()
          .sort()
          .every((code, idx) => code === voucherCodes.slice().sort()[idx])); // All elements match in both arrays are considered unchanged
    if (!isVoucherCodesUnchanged) {
      ingridCheckoutSession = await this.updateIngridSessionWithConflictRetry(
        ingridSessionId,
        ingridCheckoutSession,
        (session) => ({
          cart: {
            ...session.session.cart,
            vouchers: voucherCodes,
          },
          checkout_session_id: session.session.checkout_session_id,
        }),
      );
    }

    return ingridCheckoutSession;
  }

  /**
   * Update from Ingrid platform
   *
   * @remarks
   * Implementation to update composable commerce platform if update is triggered in Ingrid platform.
   *
   * @returns {Promise<UpdateSessionResponse>} Returns the commercetools cart id and Ingrid session id
   */
  public async update(voucherCodes?: string[]): Promise<UpdateSessionResponse> {
    const ingridTaxCategoryKey = getConfig().taxCategoryKey;

    // get commercetools cart
    const ctCart = await this.commercetoolsClient.getCartById(getCartIdFromContext());

    // get Ingrid session id
    const ingridSessionId = ctCart.custom?.fields?.ingridSessionId;

    if (!ingridSessionId) {
      appLogger.error(
        `[ERROR]: Failed to update composable commerce platform, Ingrid session ID on cart with ID "${ctCart.id}" not found.`,
      );
      throw new CustomError({
        message: 'No Ingrid session id found on cart',
        code: 'NO_INGRID_SESSION_ID_FOUND',
        httpErrorStatus: 400,
      });
    }

    // get Ingrid checkout session
    let ingridCheckoutSession: IngridGetSessionResponse | IngridUpdateSessionResponse =
      await this.ingridClient.getCheckoutSession(ingridSessionId);

    let updatedCart = await this.writeIngridSelectionToCart(ctCart, ingridCheckoutSession, ingridTaxCategoryKey);

    if (!updatedCart.taxedPrice?.totalGross) {
      appLogger.error(
        `[ERROR]: Failed to get taxed price from cart ID "${ctCart.id}", shipping address has likely not been set on commercetools cart.`,
      );
      throw new CustomError({
        message:
          'Failed to get taxed price from commercetools cart. It seems like there is no shipping address set on commercetools cart.',
        code: 'FAILED_TO_GET_TAXED_PRICE_FROM_COMMERCETOOLS_CART',
        httpErrorStatus: 400,
      });
    }

    // check if price on Ingrid (shipping-excluded) is the same as commercetools cart total minus shipping cost
    // Ingrid uses the same format for prices as commercetools
    // example: 10000 = 100.00 [Currency Code]
    const { total_value: ingridTotalValue } = ingridCheckoutSession.session.cart;
    const commercetoolsTotalTaxedValue = deductShippingCostFromCartTotalPrice(updatedCart);

    // if prices are not the same, update Ingrid checkout session
    if (ingridTotalValue !== commercetoolsTotalTaxedValue) {
      // the price push below can make Ingrid re-select a delivery group, so the refreshed
      // session is written back to the cart to avoid leaving it stale
      ingridCheckoutSession = await this.updateIngridSessionWithConflictRetry(
        ingridSessionId,
        ingridCheckoutSession,
        // we assume that the updated cart now has taxed prices
        () => ({
          ...transformCommercetoolsCartToIngridPayload(updatedCart, voucherCodes),
          checkout_session_id: ingridSessionId,
        }),
        // a concurrent change to the Ingrid session (e.g. the customer picking a different
        // delivery option) can itself resolve the price drift that triggered this push, in
        // which case there's nothing left to send
        (session) => session.session.cart.total_value === commercetoolsTotalTaxedValue,
      );
      updatedCart = await this.writeIngridSelectionToCart(updatedCart, ingridCheckoutSession, ingridTaxCategoryKey);
    }
    appLogger.info(
      `[SUCCESS]: Composable commerce platform updated by change triggered in Ingrid platform, session ID "${ingridSessionId}", cart ID "${ctCart.id}".`,
    );

    return {
      data: {
        success: true,
        cartVersion: updatedCart.version,
        ingridSessionId: ingridSessionId,
      },
    };
  }

  /**
   * Writes an Ingrid checkout session's selected delivery group (addresses, shipping method,
   * ext method id, pickup point, addons, instabox token) onto a commercetools cart.
   *
   * @param cart - The commercetools cart to update, used both as the write target and as the
   * source of the current custom field values (so a value that already exists on the cart but
   * is no longer present on the Ingrid session gets cleared)
   * @param ingridCheckoutSession - The Ingrid checkout session to read the selection from
   * @param ingridTaxCategoryKey - The tax category key to assign to the custom shipping method
   *
   * @returns {Promise<Cart>} The updated commercetools cart
   *
   * @throws {CustomError} When the Ingrid checkout session has no billing or delivery address
   */
  private async writeIngridSelectionToCart(
    cart: Cart,
    ingridCheckoutSession: IngridGetSessionResponse | IngridUpdateSessionResponse,
    ingridTaxCategoryKey: string,
  ): Promise<Cart> {
    const ingridSessionId = ingridCheckoutSession.session.checkout_session_id;

    // check for presence of billing and delivery addresses
    const { billing_address, delivery_address } = ingridCheckoutSession.session.delivery_groups[0]?.addresses ?? {};
    if (!billing_address || !delivery_address) {
      appLogger.error(
        `[ERROR]: Failed to get billing and delivery addresses from Ingrid checkout session with ID "${ingridSessionId}", cart ID "${cart.id}".`,
      );
      throw new CustomError({
        message:
          "Failed to get billing and delivery addresses from Ingrid checkout session. It seems like the addresses weren't provided by the customer.",
        code: 'FAILED_TO_GET_BILLING_OR_DELIVERY_ADDRESSES_FROM_INGRID_CHECKOUT_SESSION',
        httpErrorStatus: 400,
      });
    }

    // transform Ingrid checkout session delivery groups to commercetools data types
    const {
      billingAddress,
      deliveryAddress,
      customShippingMethod,
      extMethodId,
      pickupPointId,
      deliveryAddons,
      instaboxToken,
    } = transformIngridDeliveryGroupsToCommercetoolsDataTypes(ingridCheckoutSession.session.delivery_groups);

    const customFieldsPayload: { name: string; value: string | undefined }[] = [
      {
        name: 'ingridExtMethodId',
        value: extMethodId,
      },
    ];
    if (cart.custom?.fields?.ingridPickupPointId || pickupPointId) {
      // replace/remove existing pickup point ID in case it has already existed in commercetools cart
      // add pickup point ID in case it is not existing in commercetools cart
      customFieldsPayload.push({
        name: 'ingridPickupPointId',
        value: pickupPointId,
      });
    }
    if (cart.custom?.fields?.ingridDeliveryAddons || deliveryAddons) {
      // replace/remove existing addons in case it has already existed in commercetools cart
      // add addons in case it is not existing in commercetools cart
      customFieldsPayload.push({
        name: 'ingridDeliveryAddons',
        value: deliveryAddons,
      });
    }
    if (cart.custom?.fields?.ingridInstaboxToken || instaboxToken) {
      // replace/remove existing instabox availability token in case it has already existed in commercetools cart
      // add instabox availability token in case it is not existing in commercetools cart
      customFieldsPayload.push({
        name: 'ingridInstaboxToken',
        value: instaboxToken,
      });
    }

    return this.updateCartWithConcurrencyRetry(cart.id, cart.version, (cartVersion) =>
      this.commercetoolsClient.updateCartWithAddressAndShippingMethod(
        cart.id,
        cartVersion,
        {
          billingAddress,
          shippingAddress: deliveryAddress,
        },
        {
          shippingMethodName: customShippingMethod.shippingMethodName,
          shippingRate: customShippingMethod.shippingRate,
          taxCategory: { key: ingridTaxCategoryKey, typeId: 'tax-category' },
        },
        customFieldsPayload,
      ),
    );
  }

  /**
   * Runs a cart write, and if it fails because the cart was concurrently modified (409),
   * re-fetches the latest cart version and retries.
   *
   * @remarks
   * The Ingrid selection is written with `setCustomField`/`setShippingAddress`/etc. actions that
   * unconditionally overwrite the target fields, so retrying with a fresher version is always
   * safe: it can never merge or conflict with the concurrent change, only lose to it entirely.
   *
   * @param cartId - The ID of the cart being written to, used to refetch its latest version
   * @param cartVersion - The cart version the first attempt should use
   * @param write - Performs the write for a given cart version
   *
   * @returns {Promise<Cart>} The updated commercetools cart
   */
  private async updateCartWithConcurrencyRetry(
    cartId: string,
    cartVersion: number,
    write: (cartVersion: number) => Promise<Cart>,
    maxAttempts = 3,
  ): Promise<Cart> {
    let version = cartVersion;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await write(version);
      } catch (error) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode !== 409 || attempt === maxAttempts) {
          throw error;
        }
        appLogger.error(
          `[WARN]: Concurrent modification writing Ingrid selection to cart "${cartId}", refetching latest version and retrying (attempt ${attempt}/${maxAttempts}).`,
        );
        version = (await this.commercetoolsClient.getCartById(cartId)).version;
      }
    }
    /* istanbul ignore next -- unreachable: the loop above always returns or throws */
    throw new CustomError({
      message: `Failed to write Ingrid selection to cart "${cartId}" after ${maxAttempts} attempts due to concurrent modification.`,
      code: 'CART_CONCURRENT_MODIFICATION_RETRY_EXHAUSTED',
      httpErrorStatus: 409,
    });
  }

  /**
   * Calls `updateCheckoutSession`, and if Ingrid rejects it because the session was
   * concurrently modified (409), re-pulls the latest session and retries with a freshly
   * recomputed payload.
   *
   * @remarks
   * Unlike a commercetools version conflict, Ingrid's update payload carries no version token
   * to simply resubmit, so a 409 here means the session actually moved since `initialSession`
   * was read (e.g. the customer changed something in the widget). Blindly retrying the exact
   * same payload could just 409 again, so each retry rebuilds the payload from a fresh pull.
   *
   * @param ingridSessionId - The Ingrid checkout session ID being updated
   * @param initialSession - The most recently fetched session, used for the first attempt so a
   * redundant pull isn't made before any conflict has actually happened
   * @param buildPayload - Builds the update payload from a (possibly refreshed) session
   * @param isAlreadyConsistent - Given a freshly pulled session (after a 409), returns true if
   * the update is no longer needed, e.g. because the concurrent change already resolved the
   * discrepancy that triggered it - in which case that session is returned as-is
   *
   * @returns {Promise<IngridUpdateSessionResponse>} The updated (or already consistent) session
   */
  private async updateIngridSessionWithConflictRetry(
    ingridSessionId: string,
    initialSession: IngridGetSessionResponse | IngridUpdateSessionResponse,
    buildPayload: (
      session: IngridGetSessionResponse | IngridUpdateSessionResponse,
    ) => IngridUpdateSessionRequestPayload,
    isAlreadyConsistent?: (session: IngridGetSessionResponse) => boolean,
    maxAttempts = 3,
  ): Promise<IngridUpdateSessionResponse> {
    let session: IngridGetSessionResponse | IngridUpdateSessionResponse = initialSession;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.ingridClient.updateCheckoutSession(buildPayload(session));
      } catch (error) {
        const statusCode = error instanceof CustomError ? error.httpErrorStatus : undefined;
        if (statusCode !== 409 || attempt === maxAttempts) {
          throw error;
        }
        appLogger.error(
          `[WARN]: Ingrid session "${ingridSessionId}" was modified concurrently, refetching latest session and retrying (attempt ${attempt}/${maxAttempts}).`,
        );
        session = await this.ingridClient.getCheckoutSession(ingridSessionId);
        if (isAlreadyConsistent?.(session)) {
          return session;
        }
      }
    }
    /* istanbul ignore next -- unreachable: the loop above always returns or throws */
    throw new CustomError({
      message: `Failed to update Ingrid session "${ingridSessionId}" after ${maxAttempts} attempts due to concurrent modification.`,
      code: 'INGRID_SESSION_CONCURRENT_MODIFICATION_RETRY_EXHAUSTED',
      httpErrorStatus: 409,
    });
  }

  /**
   * Updates the cart with the Ingrid session ID, and if it fails because the cart was
   * concurrently modified (409), re-fetches the latest cart version and retries.
   *
   * @param cart - The cart to update
   * @param ingridSessionId - The Ingrid session ID to set on the cart
   * @param customTypeId - The ID of the custom type to set on the cart
   *
   * @returns {Promise<Cart>} The updated cart
   */
  private async updateCartWithIngridSessionId(
    cart: Cart,
    ingridSessionId: string,
    customTypeId: string,
    maxAttempts = 3,
  ): Promise<Cart> {
    let currentCart = cart;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!currentCart.custom) {
          currentCart = await this.commercetoolsClient.setCartCustomType(
            currentCart.id,
            currentCart.version,
            customTypeId,
          );
        }
        const updatedCart = await this.commercetoolsClient.setCartCustomField(
          currentCart.id,
          currentCart.version,
          'ingridSessionId',
          ingridSessionId,
        );
        appLogger.info(`[SUCCESS]: IngridSessionId ${ingridSessionId} is set on cart ${updatedCart.id}.`);
        return updatedCart;
      } catch (error) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode !== 409 || attempt === maxAttempts) {
          appLogger.error(`[ERROR]: Failed to set IngridSessionId ${ingridSessionId} on cart ${currentCart.id}.`);
          throw new CustomError({
            message: (error as { message?: string })?.message ?? '',
            code: (error as { code?: string })?.code ?? '',
            httpErrorStatus: statusCode ?? 500,
            cause: error,
          });
        }
        appLogger.error(
          `[WARN]: Concurrent modification setting IngridSessionId on cart "${currentCart.id}", refetching latest version and retrying (attempt ${attempt}/${maxAttempts}).`,
        );
        currentCart = await this.commercetoolsClient.getCartById(currentCart.id);
      }
    }
    /* istanbul ignore next -- unreachable: the loop above always returns or throws */
    throw new CustomError({
      message: `Failed to set IngridSessionId ${ingridSessionId} on cart "${cart.id}" after ${maxAttempts} attempts due to concurrent modification.`,
      code: 'CART_CONCURRENT_MODIFICATION_RETRY_EXHAUSTED',
      httpErrorStatus: 409,
    });
  }
}
