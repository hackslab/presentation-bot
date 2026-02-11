import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Handlebars from "handlebars";
import puppeteer from "puppeteer";

// Defined based on PresentationService types
type PresentationSlide = {
  pageNumber: number;
  title: string;
  summary: string;
  bullets: string[];
  content: string;
  imageUrl?: string;
};

type PresentationTemplateData = {
  topic: string;
  generatedAt: string;
  slides: PresentationSlide[];
};

const TEMPLATES: string[] = [
  "presentation-template.hbs",
  "template-classic.hbs",
  "template-creative.hbs",
  "template-minimal.hbs",
];

const DUMMY_DATA: PresentationTemplateData = {
  topic: "Presentation Templates",
  generatedAt: new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }),
  slides: [
    {
      pageNumber: 1,
      title: "Introduction",
      summary: "This is a preview of the presentation template style.",
      bullets: [
        "Modern and clean design",
        "Optimized for readability",
        "Customizable layouts",
        "Professional typography",
      ],
      content:
        "<p>This is a preview of the presentation template style.</p><ul><li>Modern and clean design</li><li>Optimized for readability</li><li>Customizable layouts</li><li>Professional typography</li></ul>",
    },
    {
      pageNumber: 2,
      title: "Key Features",
      summary: "Our templates are designed to be flexible and adaptive.",
      bullets: [
        "Responsive layout",
        "Consistent styling",
        "Customizable colors",
        "Standard fonts",
      ],
      content:
        "<p>Our templates are designed to be flexible and adaptive.</p><ul><li>Responsive layout</li><li>Consistent styling</li><li>Customizable colors</li><li>Standard fonts</li></ul>",
    },
  ],
};

async function main() {
  const rootDir = process.cwd();
  const templatesDir = join(rootDir, "src", "templates");
  const outputImage = join(templatesDir, "templates.png");

  // Register Helper
  Handlebars.registerHelper("addOne", (value: number) => Number(value) + 1);

  console.log("Launching browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Set viewport to A4 Landscape (1122px x 793px at 96 DPI)
  await page.setViewport({ width: 1122, height: 793, deviceScaleFactor: 2 });

  const screenshots: string[] = [];

  for (const templateName of TEMPLATES) {
    const templatePath = join(templatesDir, templateName);
    console.log(`Processing template: ${templateName}`);

    try {
      const source = await readFile(templatePath, "utf-8");
      const template = Handlebars.compile(source);
      const html = template(DUMMY_DATA);

      await page.setContent(html, { waitUntil: "load", timeout: 60000 });

      // Take a screenshot of the visible area
      const screenshot = await page.screenshot({
        encoding: "base64",
        type: "png",
      });
      screenshots.push(`data:image/png;base64,${screenshot}`);
    } catch (err) {
      console.error(`Error processing ${templateName}:`, err);
      process.exit(1);
    }
  }

  console.log("Generating composite preview...");

  const compositeHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          margin: 0;
          padding: 40px;
          background: #f0f2f5;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          box-sizing: border-box;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 40px;
          max-width: 1800px;
          width: 100%;
        }
        .card {
          position: relative;
          background: white;
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.15);
          overflow: hidden;
          transition: transform 0.2s;
        }
        .card img {
          width: 100%;
          height: auto;
          display: block;
        }
        .badge {
          position: absolute;
          top: 20px;
          left: 20px;
          background: #0088cc;
          color: white;
          width: 60px;
          height: 60px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 32px;
          font-weight: bold;
          box-shadow: 0 4px 10px rgba(0,0,0,0.3);
          z-index: 10;
        }
      </style>
    </head>
    <body>
      <div class="grid">
        ${TEMPLATES.map((name, index) => {
          const src = screenshots[index];
          return `
              <div class="card">
                <div class="badge">${index + 1}</div>
                <img src="${src}" alt="${name}" />
              </div>
            `;
        }).join("")}
      </div>
    </body>
    </html>
  `;

  await page.setViewport({ width: 2800, height: 2000, deviceScaleFactor: 2 });
  await page.setContent(compositeHtml, { waitUntil: "networkidle0" });

  const element = await page.$(".grid");
  if (element) {
    await element.screenshot({ path: outputImage, type: "png" });
    console.log(`Success! Saved composite preview to:\n${outputImage}`);
  } else {
    console.error("Could not find .grid element in composite page.");
    process.exit(1);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
