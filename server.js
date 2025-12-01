import express from "express";
import fileUpload from "express-fileupload";
import path from "path";
import fs from "fs/promises";
import xlsx from "xlsx";
import { processFile } from "./parser.js";

const app = express();
const PORT = 3000;

const UPLOADS_DIR = "./uploads";
await fs.mkdir(UPLOADS_DIR, { recursive: true });

app.use(fileUpload());
app.use(express.static("public"));

// ------------------------------------------------------------
// Загрузка файла и парсинг Excel → JSON
// ------------------------------------------------------------
app.post("/upload", async (req, res) => {
  if (!req.files || !req.files.file)
    return res.status(400).send("Файл не загружен");

  const file = req.files.file;
  const filePath = path.join(UPLOADS_DIR, file.name);
  await file.mv(filePath);

  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet);

  const goods = rows.flatMap((row) => {
    const brand = row["Бренд"];
    const codeStr = row["Код"];

    if (!brand || !codeStr) return [];

    return codeStr
      .split("/")
      .map((code) => code.trim())
      .filter((c) => c.length > 0)
      .map((code) => ({ brand, code }));
  });

  const jsonPath = path.join(UPLOADS_DIR, file.name + ".json");
  await fs.writeFile(jsonPath, JSON.stringify({ goods }, null, 2));

  res.json({ jsonPath });
});

// ------------------------------------------------------------
// Запуск парсинга
// ------------------------------------------------------------
app.post("/start", express.json(), async (req, res) => {
  const { jsonPath } = req.body;

  const resultFile = await processFile(jsonPath, "result");

  res.json({ download: "/download?file=result.xlsx" });
});

// ------------------------------------------------------------
// Выдача итогового файла
// ------------------------------------------------------------
app.get("/download", async (req, res) => {
  const file = req.query.file;
  res.download(path.join("./outputs", file));
});

app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);
