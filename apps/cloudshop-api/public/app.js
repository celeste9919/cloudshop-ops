const grid = document.querySelector("#product-grid");
const status = document.querySelector("#catalog-status");
const categoryFilter = document.querySelector("#category-filter");
const dialog = document.querySelector("#product-dialog");
const form = document.querySelector("#product-form");
const formError = document.querySelector("#form-error");

function productImage(product) {
  return product.imageUrl || "https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=960&q=80";
}

function currency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[character]);
}

function productCard(product) {
  const article = document.createElement("article");
  article.className = "product";
  article.innerHTML = `
    <img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.name)}" loading="lazy">
    <div class="product-body">
      <p class="category">${escapeHtml(product.category)}</p>
      <h2>${escapeHtml(product.name)}</h2>
      <p class="price">${currency(product.price)}</p>
      <p class="description">${escapeHtml(product.description || "No description")}</p>
      <div class="stock-row">
        <span>${escapeHtml(product.stock)} in stock</span>
        <div class="stock-actions">
          <button type="button" title="Decrease stock" aria-label="Decrease stock" data-adjust="-1">-</button>
          <button type="button" title="Increase stock" aria-label="Increase stock" data-adjust="1">+</button>
        </div>
      </div>
    </div>`;
  article.querySelectorAll("[data-adjust]").forEach((button) => {
    button.addEventListener("click", () => adjustStock(product.id, Number(button.dataset.adjust)));
  });
  return article;
}

async function loadCategories() {
  const response = await fetch("/api/categories");
  if (!response.ok) return;
  const { categories } = await response.json();
  const selected = categoryFilter.value;
  categoryFilter.innerHTML = '<option value="">All categories</option>';
  categories.forEach((category) => {
    const option = new Option(category, category, false, category === selected);
    categoryFilter.add(option);
  });
}

async function loadProducts() {
  status.textContent = "Loading catalog...";
  const query = categoryFilter.value ? `?category=${encodeURIComponent(categoryFilter.value)}` : "";
  const response = await fetch(`/api/products${query}`);
  if (!response.ok) {
    status.textContent = "Catalog is unavailable.";
    return;
  }
  const { products, source } = await response.json();
  grid.replaceChildren(...products.map(productCard));
  status.textContent = `${products.length} products, served from ${source}.`;
}

async function adjustStock(id, quantity) {
  const response = await fetch(`/api/products/${id}/stock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity })
  });
  if (!response.ok) {
    const body = await response.json();
    status.textContent = body.error || "Stock update failed.";
    return;
  }
  await loadProducts();
}

document.querySelector("#open-product-form").addEventListener("click", () => dialog.showModal());
document.querySelector("#close-product-form").addEventListener("click", () => dialog.close());
document.querySelector("#refresh-products").addEventListener("click", async () => {
  await loadCategories();
  await loadProducts();
});
categoryFilter.addEventListener("change", loadProducts);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  const data = Object.fromEntries(new FormData(form));
  if (!data.description) delete data.description;
  if (!data.imageUrl) delete data.imageUrl;
  const response = await fetch("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    const body = await response.json();
    formError.textContent = body.error || "Product creation failed.";
    return;
  }
  form.reset();
  dialog.close();
  await loadCategories();
  await loadProducts();
});

Promise.all([loadCategories(), loadProducts()]);
