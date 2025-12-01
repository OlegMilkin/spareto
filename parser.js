import fs from "fs/promises";
import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import path from "path";
import ExcelJS from "exceljs";

// ------------------------------------------------------------
// Настройки
// ------------------------------------------------------------
const CONCURRENCY = 5;
const DELAY_MS = 800;

const FILE_UPLOADS = "./uploads";
const OUTPUT_DIR = "./outputs";

await fs.mkdir(FILE_UPLOADS, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// ------------------------------------------------------------
// Нормализация бренда
// ------------------------------------------------------------
function normalizeBrand(rawBrand) {
  if (!rawBrand) return "";

  return rawBrand
    .trim()
    .split(/\s+/)           // разбиваем по пробелу(ам)
    .map(word => word.toUpperCase())  // каждое слово в UPPERCASE
    .join(" ");
}

// ------------------------------------------------------------
// Генерация URL поиска
// ------------------------------------------------------------
function makeUrl(code, brand) {
  const cleanBrand = normalizeBrand(brand);
  const brandEncoded = encodeURIComponent(cleanBrand);

  return `https://spareto.com/products?utf8=%E2%9C%93&keywords=${encodeURIComponent(
    code
  )}&sort_by=&brand%5B%5D=${brandEncoded}`;
}

// ------------------------------------------------------------
// Парсинг Cross-Refs
// ------------------------------------------------------------
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
    el.find(".col-md-10 span, .col-md-10 a").each(function () {
      const t = $(this).text().trim();
      if (t) values.push(t);
    });

    result.push({ brand, values });

    el = el.next();
  }

  return result;
}

// ------------------------------------------------------------
// Парсинг страницы товара
// ------------------------------------------------------------
async function parseProductPage(url) {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(res.data);

    const title = $("h1.product-title").first().text().trim();
    const price = $('[itemprop="price"]').first().text().trim();

    const crossRefs = getCrossRefs($);

    return { title, price, crossRefs, url };
  } catch (err) {
    return { error: err.message, url };
  }
}

// ------------------------------------------------------------
// Парсинг одного товара
// ------------------------------------------------------------
async function parseOne(item) {
  const originalBrand = item.brand || item["Бренд"];
  const brand = normalizeBrand(originalBrand);
  const code = item.code || item["Код"];

  const searchUrl = makeUrl(code, brand);

  try {
    const response = await axios.get(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(response.data);

    const container = $("#products-js");
    const firstCard = container.find(".card-col").first();

    if (!firstCard || firstCard.length === 0) {
      return { brand, code, found: false };
    }

    const firstLink = firstCard.find("a").first().attr("href");
    const fullLink = firstLink ? "https://spareto.com" + firstLink : null;

    if (!fullLink) {
      return { brand, code, found: false };
    }

    await wait(DELAY_MS);

    const productData = await parseProductPage(fullLink);

    return {
      brand,
      code,
      found: true,
      href: fullLink,
      productData,
    };
  } catch (err) {
    return { brand, code, error: err.message };
  } finally {
    await wait(DELAY_MS);
  }
}

// ------------------------------------------------------------
// Создание Excel после парсинга
// ------------------------------------------------------------
async function createExcel(results, outPath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Results");

  sheet.columns = [
    { header: "Бренд", key: "brand", width: 20 },
    { header: "Код", key: "code", width: 30 },
    { header: "Аналоги", key: "analogs", width: 25 },
    { header: "", key: "value", width: 30 },
  ];

  results.forEach((item) => {
    if (!item.found) {
      sheet.addRow({
        brand: item.brand,
        code: item.code,
        analogs: "Страница не найдена",
        value: "",
      });
      return;
    }

    const cross = item.productData?.crossRefs || [];

    if (cross.length === 0) {
      sheet.addRow({
        brand: item.brand,
        code: item.code,
        analogs: "Аналоги не найдены",
        value: "",
      });
      return;
    }

    cross.forEach((ref) => {
      ref.values.forEach((val) => {
        sheet.addRow({
          brand: item.brand,
          code: item.code,
          analogs: ref.brand,
          value: val,
        });
      });
    });
  });

  await workbook.xlsx.writeFile(outPath);
}

// ------------------------------------------------------------
// Основной процесс
// ------------------------------------------------------------
export async function processFile(uploadedJsonPath, outputName) {
  const raw = await fs.readFile(uploadedJsonPath, "utf8");
  const json = JSON.parse(raw);

  const limit = pLimit(CONCURRENCY);
  const tasks = json.goods.map((item) => limit(() => parseOne(item)));

  const results = await Promise.all(tasks);

  const outPath = path.join(OUTPUT_DIR, outputName + ".xlsx");
  await createExcel(results, outPath);

  return outPath;
}
