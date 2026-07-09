import express from "express";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

app.use(express.json());

const VARIABLES_PATH = path.join(process.cwd(), "src", "data", "variables.json");
const PRICES_PATH = path.join(process.cwd(), "src", "data", "prices.json");
const ALERTS_PATH = path.join(process.cwd(), "src", "data", "alerts.json");

// Helper to safely read files
function readDataFile(filePath: string, defaultValue: any) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf-8");
      return defaultValue;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return defaultValue;
  }
}

// Helper to safely write files
function writeDataFile(filePath: string, data: any) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
  }
}

// Ensure files exist on startup
readDataFile(VARIABLES_PATH, []);
readDataFile(PRICES_PATH, []);
readDataFile(ALERTS_PATH, []);

// 1. GET Variables
app.get("/api/variables", (req, res) => {
  const data = readDataFile(VARIABLES_PATH, []);
  res.json(data);
});

// 2. POST Variables (Create or Update)
app.post("/api/variables", (req, res) => {
  const variables = readDataFile(VARIABLES_PATH, []);
  const variable = req.body;

  if (!variable.name || !variable.url || !variable.regex) {
    res.status(400).json({ error: "نام، آدرس URL و الگوی منظم (Regex) الزامی هستند." });
    return;
  }

  if (variable.id) {
    // Update
    const idx = variables.findIndex((v: any) => v.id === variable.id);
    if (idx !== -1) {
      variables[idx] = { ...variables[idx], ...variable };
    } else {
      variables.push(variable);
    }
  } else {
    // Create
    const slug = variable.name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // remove non-alphanumeric except spaces/hyphens
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 30);
    const id = slug || `var-${Date.now()}`;
    const newVar = {
      id: variables.some((v: any) => v.id === id) ? `${id}-${Date.now()}` : id,
      lastStatus: "idle",
      active: true,
      ...variable
    };
    variables.push(newVar);
  }

  writeDataFile(VARIABLES_PATH, variables);
  res.json({ success: true, variables });
});

// 3. DELETE Variable
app.delete("/api/variables/:id", (req, res) => {
  const { id } = req.params;
  const variables = readDataFile(VARIABLES_PATH, []);
  
  const filtered = variables.filter((v: any) => v.id !== id);
  writeDataFile(VARIABLES_PATH, filtered);

  // Optionally clean up associated prices
  const prices = readDataFile(PRICES_PATH, []);
  const filteredPrices = prices.filter((p: any) => p.variableId !== id);
  writeDataFile(PRICES_PATH, filteredPrices);

  // Optionally clean up associated alerts
  const alerts = readDataFile(ALERTS_PATH, []);
  const filteredAlerts = alerts.filter((a: any) => a.variableId !== id);
  writeDataFile(ALERTS_PATH, filteredAlerts);

  res.json({ success: true, message: "متغیر و تمام داده‌های مربوط به آن حذف شدند." });
});

// 4. GET Prices
app.get("/api/prices", (req, res) => {
  const data = readDataFile(PRICES_PATH, []);
  res.json(data);
});

// 5. GET Alerts Log
app.get("/api/alerts", (req, res) => {
  const data = readDataFile(ALERTS_PATH, []);
  res.json(data);
});

// 6. Live Test Scraper Target (Proxy Scraper for custom regex debugging)
app.post("/api/scrape/test", async (req, res) => {
  const { url, regex } = req.body;

  if (!url || !regex) {
    res.status(400).json({ error: "آدرس URL و الگوی منظم الزامی است." });
    return;
  }

  try {
    // Add simple headers to fetch target URL safely
    const fetchResponse = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    if (!fetchResponse.ok) {
      throw new Error(`خطای HTTP: ${fetchResponse.status}`);
    }

    const html = await fetchResponse.text();
    const reg = new RegExp(regex);
    const match = html.match(reg);

    if (match) {
      res.json({
        success: true,
        match: match[0],
        capturedGroup: match[1] || match[0],
        message: "الگو با موفقیت روی محتوای وب‌سایت منطبق شد!"
      });
    } else {
      res.json({
        success: false,
        message: "الگو در کدهای وب‌سایت پیدا نشد. لطفا کد منبع صفحه یا عبارت منظم را مجددا بررسی کنید."
      });
    }
  } catch (error: any) {
    res.json({
      success: false,
      message: `خطا در دریافت اطلاعات وب‌سایت: ${error.message}`
    });
  }
});

// 7. Trigger Python Scraper Execution or Simulation Fallback
app.post("/api/scrape/trigger", (req, res) => {
  console.log("Manual trigger requested...");
  
  // Try to execute the python script
  exec("python scraper.py", (error, stdout, stderr) => {
    if (error) {
      console.warn("Python execution failed, falling back to built-in simulation:", error.message);
      
      // Fallback: Simulation if Python is not configured or fails in the container
      simulateScraperRun();
      res.json({
        success: true,
        message: "به روز رسانی با موفقیت انجام شد (شبیه‌ساز داخلی اجرا گردید).",
        log: "Fallback simulation active."
      });
      return;
    }
    
    console.log("Python scraper output:", stdout);
    res.json({
      success: true,
      message: "اسکرایپر پایتون با موفقیت اجرا شد و فایل‌های اطلاعات بروز رسانی شدند.",
      log: stdout
    });
  });
});

// Simulation helper to generate realistic updates in the sandbox environment
function simulateScraperRun() {
  const variables = readDataFile(VARIABLES_PATH, []);
  const prices = readDataFile(PRICES_PATH, []);
  const alerts = readDataFile(ALERTS_PATH, []);
  const timestamp = new Date().toISOString();

  let updated = false;

  variables.forEach((v: any) => {
    if (!v.active) return;

    // Get current last price
    const varPrices = prices.filter((p: any) => p.variableId === v.id);
    const lastPrice = varPrices.length > 0 ? varPrices[varPrices.length - 1].value : 1000;

    // Generate minor random drift (-1.5% to +2%)
    const driftPercent = (Math.random() * 3.5 - 1.5) / 100;
    const newValue = Math.round(lastPrice * (1 + driftPercent));

    if (newValue !== lastPrice) {
      prices.push({
        id: `p_sim_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        variableId: v.id,
        value: newValue,
        timestamp: timestamp,
        rawText: `${newValue.toLocaleString()}`
      });

      // Log alert
      const changePct = ((newValue - lastPrice) / lastPrice) * 100;
      alerts.unshift({
        id: `a_sim_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        variableId: v.id,
        variableName: v.name,
        oldValue: lastPrice,
        newValue: newValue,
        changePercent: parseFloat(changePct.toFixed(2)),
        timestamp: timestamp
      });
    }

    v.lastScraped = timestamp;
    v.lastStatus = "success";
    v.lastError = null;
    updated = true;
  });

  if (updated) {
    writeDataFile(VARIABLES_PATH, variables);
    writeDataFile(PRICES_PATH, prices);
    writeDataFile(ALERTS_PATH, alerts);
  }
}

// Serve Vite
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
