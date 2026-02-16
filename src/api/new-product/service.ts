export interface ProductStatusResponse {
  productId: string;
  status: 'active' | 'paused';
  region: string;
}

export const getProductStatus = (productId: string): ProductStatusResponse => {
  return {
    productId,
    status: 'active',
    region: 'us-east-1',
  };
};

export const pauseProduct = (productId: string): ProductStatusResponse => {
  return {
    productId,
    status: 'paused',
    region: 'us-east-1',
  };
};
