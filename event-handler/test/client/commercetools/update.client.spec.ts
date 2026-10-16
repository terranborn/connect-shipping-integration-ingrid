import * as createClientModule from '../../../src/client/commercetools/create.client';
import { changeShipmentState } from '../../../src/client/commercetools/update.client';
import { readConfiguration } from '../../../src/utils/config.utils';
import CustomError from '../../../src/errors/custom.error';
import type {
  ByProjectKeyOrdersRequestBuilder,
  ByProjectKeyRequestBuilder,
} from '@commercetools/platform-sdk';

// Add Jest imports
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mockConfiguration } from '../../mock/mock-configuration';
import { mockApiRootUpdateResponse } from '../../mock/mock-api-root';

// Mocks
jest.mock('../../../src/utils/config.utils');
jest.mock('../../../src/client/commercetools/create.client', () => ({
  createApiRoot: jest.fn(),
}));

describe('Update Client', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock readConfiguration to return valid configuration
    jest.mocked(readConfiguration).mockReturnValue(mockConfiguration);
  });

  describe('changeShipmentState', () => {
    it('should call the commercetools API with correct parameters', async () => {
      const mockOrderId = 'test-order-id';
      const mockOrderVersion = 1;
      const mockShipmentState = 'Shipped';

      const mockCommercetoolsUpdateOrders = mockApiRootUpdateResponse({
        body: {
          id: mockOrderId,
          version: mockOrderVersion,
        },
      });

      type MockApiRoot = Partial<ByProjectKeyRequestBuilder> & {
        orders: Partial<ByProjectKeyOrdersRequestBuilder>;
      };

      // Set up the mock without type checking issues
      const mockApiRoot: MockApiRoot = {
        orders: mockCommercetoolsUpdateOrders as MockApiRoot['orders'],
      };

      jest
        .spyOn(createClientModule, 'createApiRoot')
        .mockReturnValue(mockApiRoot as ByProjectKeyRequestBuilder);

      const result = await changeShipmentState(
        mockOrderId,
        mockOrderVersion,
        mockShipmentState
      );

      expect(createClientModule.createApiRoot).toHaveBeenCalled();
      expect(typeof result).toBe('object');
      expect(mockApiRoot.orders).toHaveBeenCalled();
      expect(result).toEqual({
        id: mockOrderId,
        version: mockOrderVersion + 1,
      });
    });

    it('retries once on a concurrent modification (409) and succeeds', async () => {
      const mockOrderId = 'test-order-id';
      const conflictError = Object.assign(new Error('ConcurrentModification'), {
        statusCode: 409,
      });

      const post = jest
        .fn()
        .mockReturnValueOnce({ execute: () => Promise.reject(conflictError) })
        .mockReturnValueOnce({
          execute: () =>
            Promise.resolve({ body: { id: mockOrderId, version: 3 } }),
        });
      const get = jest.fn().mockReturnValue({
        execute: () => Promise.resolve({ body: { version: 2 } }),
      });
      const withId = jest.fn().mockReturnValue({ post, get });
      const orders = jest.fn().mockReturnValue({ withId });

      jest
        .spyOn(createClientModule, 'createApiRoot')
        .mockReturnValue({ orders } as unknown as ByProjectKeyRequestBuilder);

      const result = await changeShipmentState(mockOrderId, 1, 'Ready');

      expect(result).toEqual({ id: mockOrderId, version: 3 });
      expect(post).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          body: expect.objectContaining({ version: 1 }),
        })
      );
      expect(post).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          body: expect.objectContaining({ version: 2 }),
        })
      );
    });

    it('wraps a non-conflict error as a retryable CustomError without retrying', async () => {
      const mockOrderId = 'test-order-id';
      const serverError = Object.assign(new Error('Internal Server Error'), {
        statusCode: 500,
      });

      const post = jest
        .fn()
        .mockReturnValue({ execute: () => Promise.reject(serverError) });
      const withId = jest.fn().mockReturnValue({ post });
      const orders = jest.fn().mockReturnValue({ withId });

      jest
        .spyOn(createClientModule, 'createApiRoot')
        .mockReturnValue({ orders } as unknown as ByProjectKeyRequestBuilder);

      let caughtError: unknown;
      try {
        await changeShipmentState(mockOrderId, 1, 'Ready');
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(CustomError);
      expect((caughtError as CustomError).statusCode).toBe(502);
      expect(post).toHaveBeenCalledTimes(1);
    });
  });
});
