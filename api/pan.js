import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';
import path from 'path';

const CHROMIUM_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

// Force AL2023 environment detection for @sparticuz/chromium on Vercel
process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';

let cachedBrowser = null;

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

  if (req.query?.test === '1') {
    try {
      const t0 = Date.now();
      const resp = await fetch('https://ird.gov.np/pan-search/', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(6000)
      });
      const text = await resp.text();
      return res.status(200).json({
        timeMs: Date.now() - t0,
        status: resp.status,
        hasForm: text.includes('getPanSearch'),
        length: text.length
      });
    } catch (e) {
      return res.status(500).json({
        error: e.message
      });
    }
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

  const t0 = Date.now();
  const marks = {};

  let page = null;
  try {
    const fs = await import('node:fs');
    if (fs.existsSync('/tmp/chromium') && !fs.existsSync('/tmp/al2023/lib/libnss3.so')) {
      try {
        fs.unlinkSync('/tmp/chromium');
      } catch (e) {}
    }

    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath(CHROMIUM_URL);
    marks.executable = Date.now() - t0;

    const al2023Lib = '/tmp/al2023/lib';
    if (!process.env.LD_LIBRARY_PATH || !process.env.LD_LIBRARY_PATH.includes(al2023Lib)) {
      process.env.LD_LIBRARY_PATH = [al2023Lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--hide-scrollbars',
        '--disable-web-security',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless
    });
    marks.browserReady = Date.now() - t0;

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );

    let irdData = null;
    page.on('response', async (response) => {
      try {
        if (response.url().includes('/api/getPanSearch/')) {
          const json = await response.json();
          if (json && (json.code === 1 || json.data)) {
            irdData = json.data || json;
          }
        }
      } catch (e) {}
    });

    // Navigate to IRD pan search page
    await page.goto(`https://ird.gov.np/pan-search/?pan=${pan}`, {
      waitUntil: 'networkidle2',
      timeout: 18000
    });
    marks.pageNavigated = Date.now() - t0;

    if (!irdData) {
      await page.waitForSelector('#submit', { timeout: 4000 }).catch(() => {});
      await page.click('#submit').catch(() => {});
      marks.submitClicked = Date.now() - t0;

      await page
        .waitForResponse((res) => res.url().includes('/api/getPanSearch/'), { timeout: 6000 })
        .catch(() => {});
    }

    await browser.close();
    browser = null;

    if (irdData) {
      return res.status(200).json({
        success: true,
        pan: pan,
        timing: marks,
        data: irdData,
        source: 'IRD Nepal Official Portal'
      });
    } else {
      return res.status(404).json({
        success: false,
        pan: pan,
        timing: marks,
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
      timing: marks,
      message: error.message || 'Serverless verification error'
    });
  }
}
