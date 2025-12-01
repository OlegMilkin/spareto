import express from "express";
import bodyParser from "body-parser";
import fs from "fs/promises";
import path from "path";
import { parseAllGoodsWithProgress } from "./parser.js";

const app = express();
const PORT = 3000;

app.use(bodyParser.json({ limit: "200mb" }));
app.use(express.static(path.join(".", "public")));

let clients = [];

// SSE endpoint for progress
app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // send a comment to keep connection alive initially
  res.write(": connected\n\n");

  clients.push(res);
  req.on("close", () => {
    clients = clients.filter((c) => c !== res);
  });
});

// helper to broadcast progress to all connected clients
function sendProgressToClients(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach((res) => {
    try { res.write(msg); } catch (e) { /* ignore */ }
  });
}

// main parse endpoint — receives JSON { goods: [...] }
app.post("/parse", async (req, res) => {
  try {
    const jsonData = req.body;

    // save for parser (optional)
    await fs.writeFile("data.json", JSON.stringify(jsonData, null, 2), "utf8");

    // call parser with progress callback
    await parseAllGoodsWithProgress((progressObj) => {
      // progressObj: { current, total, success, errors, done }
      sendProgressToClients(progressObj);
    });

    // read generated excel and return as file download (binary)
    const excelPath = path.join(".", "result.xlsx");
    const buffer = await fs.readFile(excelPath);

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="result.xlsx"'
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    // send buffer as response
    res.send(buffer);
  } catch (err) {
    console.error("Error /parse:", err);
    res.status(500).send({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
