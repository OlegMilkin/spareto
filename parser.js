import fs from "fs/promises";
import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import xlsx from "xlsx";
import path from "path";

const CONCURRENCY = 5;
const DELAY_MS = 800;
const WAIT_BEFORE_RETRY_MS = 1000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeBrand(rawBrand) {
  if (!rawBrand) return "";
  return rawBrand
    .toString()
    .trim()
    .split(/\s+/)
    .map((w) => w.toUpperCase())
    .join(" ");
}

function makeUrl(code, brand) {
  const cleanBrand = normalizeBrand(brand);
  const brandEncoded = encodeURIComponent(cleanBrand);
  const codeEnc = encodeURIComponent(code);
  return `https://spareto.com/products?utf8=%E2%9C%93&keywords=${codeEnc}&sort_by=&brand%5B%5D=${brandEncoded}`;
}

function getCrossRefs($) {
  const result = [];

  const header = $("h3.mt-3")
    .filter(function () {
      return $(this).text().trim() === "Cross-Reference Numbers";
    })
    .first();

  if (!header || header.length === 0) return result;

  let el = header.next();
  while (el.length > 0) {
    if (!el.hasClass("row") || !el.hasClass("py-2")) break;

    const brand = el.find(".col-md-2, .col-4").first().text().trim();
    const values = [];

    // FIX: cheerio(this) → $(this)
    el.find(".col-md-10 span, .col-md-10 a").each(function () {
      const t = $(this).text().trim();
      if (t) values.push(t);
    });

    result.push({ brand, values });
    el = el.next();
  }

  return result;
}

async function fetchHtml(url, retries = 2) {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    if (retries > 0) {
      await wait(WAIT_BEFORE_RETRY_MS);
      return fetchHtml(url, retries - 1);
    }
    throw err;
  }
}

async function parseProductPage(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const title = $("h1.product-title").first().text().trim() || "";
    const price = $('[itemprop="price"]').first().text().trim() || "";
    const crossRefs = getCrossRefs($);

    return { title, price, crossRefs, url };
  } catch (err) {
    return { error: err.message, url };
  }
}

async function parseOne(item) {
  const originalBrand = item.brand;
  const brand = normalizeBrand(originalBrand);
  const code = item.code;

  const searchUrl = makeUrl(code, brand);

  try {
    const html = await fetchHtml(searchUrl);
    const $ = cheerio.load(html);
    const container = $("#products-js");
    const firstCard = container.find(".card-col").first();

    if (!firstCard || firstCard.length === 0) {
      return { brand, code, found: false };
    }

    const firstLink = firstCard.find("a").first().attr("href");
    if (!firstLink) {
      return { brand, code, found: false };
    }

    await wait(DELAY_MS);

    const productData = await parseProductPage("https://spareto.com" + firstLink);

    return {
      brand,
      code,
      found: true,
      href: "https://spareto.com" + firstLink,
      productData,
    };
  } catch (err) {
    return { brand, code, found: false, error: err.message };
  }
}

async function exportToExcel(results) {
  const rows = [];
  rows.push(["Бренд", "Код", "Аналоги", ""]);

  for (const item of results) {
    const brand = item.brand || "";
    const code = item.code || "";

    if (!item.found) {
      rows.push([brand, code, "Страница не найдена", ""]);
      continue;
    }

    const cross = item.productData?.crossRefs || [];
    if (!cross || cross.length === 0) {
      rows.push([brand, code, "Аналоги не найдены", ""]);
      continue;
    }

    let first = true;
    for (const block of cross) {
      for (const value of block.values) {
        if (first) {
          rows.push([brand, code, block.brand, value]);
          first = false;
        } else {
          rows.push(["", "", block.brand, value]);
        }
      }
    }
  }

  const ws = xlsx.utils.aoa_to_sheet(rows);

  const colWidths = rows[0].map((_, i) => {
    const max = Math.max(...rows.map((r) => (r[i] ? r[i].toString().length : 0)));
    return { wch: Math.min(Math.max(max + 2, 10), 60) };
  });
  ws["!cols"] = colWidths;

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
  const outPath = path.join(".", "result.xlsx");
  xlsx.writeFile(wb, outPath);
  return outPath;
}

export async function parseAllGoodsWithProgress(sendProgress) {
  const raw = await fs.readFile("data.json", "utf8");
  const json = JSON.parse(raw);
  const goods = Array.isArray(json.goods) ? json.goods : [];

  const total = goods.length;
  const results = [];
  let count = 0;
  let success = 0;
  let errors = 0;

  const limit = pLimit(CONCURRENCY);

  const tasks = goods.map((g) =>
    limit(async () => {
      const res = await parseOne(g);
      results.push(res);

      count++;
      if (res.found && !res.error) success++;
      else errors++;

      if (typeof sendProgress === "function") {
        sendProgress({ current: count, total, success, errors, done: false });
      }
    })
  );

  await Promise.all(tasks);

  if (typeof sendProgress === "function") {
    sendProgress({ current: total, total, success, errors, done: true });
  }

  await fs.writeFile("output.json", JSON.stringify(results, null, 2), "utf8");
  await exportToExcel(results);
}
