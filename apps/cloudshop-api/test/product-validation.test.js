const test = require("node:test");
const assert = require("node:assert/strict");
const { validateProductInput, validateStockAdjustment } = require("../product-validation");

test("validates and normalizes a product", () => {
  const result = validateProductInput({
    name: "  Keyboard  ",
    price: "299.00",
    category: " Accessories ",
    description: "  Compact mechanical keyboard  ",
    imageUrl: "https://example.com/keyboard.jpg",
    stock: "12"
  });

  assert.deepEqual(result, {
    value: {
      name: "Keyboard",
      price: 299,
      category: "Accessories",
      description: "Compact mechanical keyboard",
      imageUrl: "https://example.com/keyboard.jpg",
      stock: 12
    }
  });
});

test("rejects invalid product and inventory values", () => {
  assert.equal(validateProductInput().error, "name must be between 1 and 120 characters");
  assert.equal(validateProductInput({ name: "", price: 1 }).error, "name must be between 1 and 120 characters");
  assert.equal(validateProductInput({ name: "Mouse", price: -1 }).error, "price must be a non-negative number");
  assert.equal(validateProductInput({ name: "Mouse", price: 1, imageUrl: "file:///tmp/image" }).error, "imageUrl must be a valid HTTP(S) URL or null");
  assert.equal(validateStockAdjustment({ quantity: 0 }).error, "quantity must be a non-zero whole number between -1000000 and 1000000");
});
