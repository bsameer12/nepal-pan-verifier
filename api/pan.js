import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';
import path from 'path';

const CHROMIUM_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.query?.debug === '1') {
    const fs = await import('node:fs');
    let tmpFiles = [];
    try {
      tmpFiles = fs.readdirSync('/tmp');
    } catch (e) {
      tmpFiles = [e.message];
    }
    let al2023Files = [];
    try {
      al2023Files = fs.readdirSync('/tmp/al2023/lib');
    } catch (e) {
      al2023Files = [e.message];
    }
    return res.status(200).json({
      tmp: tmpFiles,
      al2023: al2023Files,
      node: process.version,
      env: {
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
        VERCEL: process.env.VERCEL,
        AWS_EXECUTION_ENV: process.env.AWS_EXECUTION_ENV
      }
    });
  }

  // Extract PAN from query or body
  const rawPan = req.query?.pan || req.body?.pan || '';
  const pan = String(rawPan).replace(/\D/g, '');

  if (pan.length !== 9) {
    return res.status(400).json({
      success: false,
      pan: pan,
      message: 'PAN number must be exactly 9 numeric digits.'
    });
  }

  let browser = null;
  try {
    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath(CHROMIUM_URL);
    const execDir = path.dirname(executablePath);
    process.env.LD_LIBRARY_PATH = `${process.env.LD_LIBRARY_PATH || ''}:${execDir}:${execDir}/lib`;

    browser = await puppeteer.launch({
      args: [...chromium.args, '--hide-scrollbars', '--disable-web-security', '--no-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );

    let irdData = null;

    // Intercept network response from official IRD API
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/getPanSearch/')) {
        try {
          const json = await response.json();
          if (json && (json.code === 1 || json.data)) {
            irdData = json.data;
          }
        } catch (e) {
          // ignore parsing error
        }
      }
    });

    // Navigate to IRD (invisible reCAPTCHA executes naturally in the real browser session)
    await page.goto(`https://ird.gov.np/pan-search/?pan=${pan}`, {
      waitUntil: 'networkidle2',
      timeout: 18000
    });

    // Short wait to ensure async network intercept completes
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await browser.close();

    if (irdData) {
      return res.status(200).json({
        success: true,
        pan: pan,
        data: irdData,
        source: 'IRD Nepal Official Portal'
      });
    } else {
      return res.status(404).json({
        success: false,
        pan: pan,
        message: 'Taxpayer record not found or unverified on IRD portal'
      });
    }
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    return res.status(500).json({
      success: false,
      pan: pan,
      message: error.message || 'Serverless verification error'
    });
  }
}
