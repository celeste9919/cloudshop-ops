function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateProductInput(input = {}, options = {}) {
  const partial = options.partial === true;
  const product = {};

  if (!partial || Object.hasOwn(input, "name")) {
    const name = normalizeString(input.name);
    if (!name || name.length > 120) {
      return { error: "name must be between 1 and 120 characters" };
    }
    product.name = name;
  }

  if (!partial || Object.hasOwn(input, "price")) {
    const price = Number(input.price);
    if (!Number.isFinite(price) || price < 0 || price > 99999999.99) {
      return { error: "price must be a non-negative number" };
    }
    product.price = price;
  }

  if (!partial || Object.hasOwn(input, "category")) {
    const category = input.category === undefined ? "General" : normalizeString(input.category);
    if (!category || category.length > 80) {
      return { error: "category must be between 1 and 80 characters" };
    }
    product.category = category;
  }

  if (Object.hasOwn(input, "description")) {
    if (input.description !== null && (typeof input.description !== "string" || input.description.trim().length > 2000)) {
      return { error: "description must be null or at most 2000 characters" };
    }
    product.description = input.description === null ? null : input.description.trim();
  }

  if (Object.hasOwn(input, "imageUrl")) {
    if (input.imageUrl !== null && (typeof input.imageUrl !== "string" || !/^https?:\/\//.test(input.imageUrl) || input.imageUrl.length > 2048)) {
      return { error: "imageUrl must be a valid HTTP(S) URL or null" };
    }
    product.imageUrl = input.imageUrl;
  }

  if (!partial || Object.hasOwn(input, "stock")) {
    const stock = input.stock === undefined ? 0 : Number(input.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) {
      return { error: "stock must be a whole number between 0 and 1000000" };
    }
    product.stock = stock;
  }

  return { value: product };
}

function validateStockAdjustment(input = {}) {
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity === 0 || quantity < -1000000 || quantity > 1000000) {
    return { error: "quantity must be a non-zero whole number between -1000000 and 1000000" };
  }
  return { value: quantity };
}

module.exports = { validateProductInput, validateStockAdjustment };
