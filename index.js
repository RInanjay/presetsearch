const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// === DAFTAR DOMAIN ALIGHT MOTION ===
const ALIGHT_DOMAINS = [
    'alight.page.link',
    'alight-creative.firebaseapp.com',
    'alightcreative.page.link',
    'alight-creative-staging.firebaseapp.com',
    'alight.to',
    'alightcreative.com'
];

// === FUNGSI CEK URL ALIGHT ===
function isAlightUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        return ALIGHT_DOMAINS.some(d => host === d || host.endsWith('.' + d));
    } catch {
        return false;
    }
}

// === HELPER: PARSE COOKIE STRING ===
function parseCookieString(cookieStr) {
    if (!cookieStr) return [];
    return cookieStr.split(';').map(c => {
        const [name, ...valueParts] = c.trim().split('=');
        return {
            name: name.trim(),
            value: valueParts.join('=').trim(),
            domain: '.tiktok.com',
            path: '/'
        };
    }).filter(c => c.name && c.value);
}

// === ENDPOINT UTAMA ===
app.get('/api/preset', async (req, res) => {
    const videoUrl = req.query.url;
    const maxScroll = parseInt(req.query.scroll) || 10;
    const waitMs = parseInt(req.query.wait) || 3000;
    const cookie = req.query.cookie || process.env.TIKTOK_COOKIE || '';

    if (!videoUrl) {
        return res.status(400).json({
            success: false,
            error: 'Parameter "url" wajib diisi. Contoh: /api/preset?url=https://vt.tiktok.com/xxx/'
        });
    }

    if (!/tiktok\.com/i.test(videoUrl)) {
        return res.status(400).json({
            success: false,
            error: 'URL harus dari TikTok'
        });
    }

    let browser;
    const startedAt = Date.now();

    try {
        console.log(`[${new Date().toISOString()}] Request: ${videoUrl}`);
        console.log(`Cookie: ${cookie ? 'YES' : 'NO'}`);
        console.log(`Scroll: ${maxScroll}, Wait: ${waitMs}ms`);

        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
            viewport: { width: 412, height: 915 },
            locale: 'id-ID',
            timezoneId: 'Asia/Jakarta',
            extraHTTPHeaders: {
                'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        // === TAMBAH COOKIE KALO ADA ===
        if (cookie) {
            const cookies = parseCookieString(cookie);
            if (cookies.length > 0) {
                await context.addCookies(cookies);
                console.log(`✅ ${cookies.length} cookies ditambahkan`);
            }
        }

        const page = await context.newPage();

        // === ANTI-DETECT BOT ===
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
            
            // Override chrome runtime
            window.chrome = {
                runtime: {},
                loadTimes: function() {},
                csi: function() {},
                app: {}
            };
        });

        console.log('📥 Membuka halaman TikTok...');
        await page.goto(videoUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // Tunggu awal
        await page.waitForTimeout(5000);

        // === TUTUP POPUP LOGIN KALO ADA ===
        const closeSelectors = [
            '[data-e2e="modal-close-inner-button"]',
            'button[aria-label="Close"]',
            'button[aria-label="Tutup"]',
            '[data-e2e="browse-close"]',
            '.close-icon',
            'svg[class*="close"]'
        ];

        for (const sel of closeSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    await btn.click();
                    console.log(`✅ Popup ditutup dengan selector: ${sel}`);
                    await page.waitForTimeout(1500);
                    break;
                }
            } catch (e) {}
        }

        // === SCROLL LEBIH BANYAK & LAMA ===
        console.log(`📜 Scroll ${maxScroll} kali...`);
        for (let i = 0; i < maxScroll; i++) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
            await page.waitForTimeout(waitMs);
            console.log(`   Scroll ${i + 1}/${maxScroll}`);
        }

        // Scroll ke paling atas buat load pinned comment
        console.log('📜 Scroll ke atas buat load pinned comment...');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(3000);

        // Scroll pelan-pelan lagi ke bawah biar komentar keload
        console.log('📜 Scroll pelan-pelan lagi...');
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await page.waitForTimeout(2000);
        }

        // === AMBIL SEMUA TEXT ===
        const pageText = await page.evaluate(() => document.body.innerText);

        // === AMBIL SEMUA LINK DARI <a> ===
        const hrefLinks = await page.evaluate(() => {
            const links = [];
            document.querySelectorAll('a[href]').forEach(a => {
                const href = a.href;
                if (href && href.startsWith('http')) {
                    links.push(href);
                }
            });
            return links;
        });

        // === AMBIL LINK DARI DATA ATTRIBUTE (komentar sering pake ini) ===
        const dataLinks = await page.evaluate(() => {
            const links = [];
            
            // Cari di elemen komentar
            document.querySelectorAll('[data-e2e*="comment"]').forEach(el => {
                const text = el.innerText || '';
                const urls = text.match(/https?:\/\/[^\s]+/g) || [];
                links.push(...urls);
            });
            
            // Cari di semua span/p yang mengandung "http"
            document.querySelectorAll('span, p, div').forEach(el => {
                const text = el.innerText || '';
                if (text.includes('http') && text.length < 500) {
                    const urls = text.match(/https?:\/\/[^\s]+/g) || [];
                    links.push(...urls);
                }
            });
            
            return links;
        });

        // === AMBIL CAPTION ===
        const caption = await page.evaluate(() => {
            const meta = document.querySelector('meta[property="og:description"]');
            return meta ? meta.content : '';
        }).catch(() => '');

        // === AMBIL JUMLAH KOMENTAR (buat debug) ===
        const commentCount = await page.evaluate(() => {
            return document.querySelectorAll('[data-e2e*="comment-level"]').length;
        }).catch(() => 0);

        await browser.close();
        browser = null;

        // === GABUNG SEMUA LINK ===
        const textUrls = pageText.match(/https?:\/\/[^\s]+/g) || [];
        const allUrls = [...new Set([...textUrls, ...hrefLinks, ...dataLinks])];

        // Filter Alight Motion
        const presetLinks = allUrls.filter(isAlightUrl);

        const elapsed = Date.now() - startedAt;

        console.log(`✅ Selesai ${elapsed}ms - ${presetLinks.length} preset dari ${allUrls.length} link`);
        console.log(`📊 Komentar terdeteksi: ${commentCount}`);

        res.json({
            success: true,
            video: {
                url: videoUrl,
                caption: caption || null
            },
            scan: {
                total_links: allUrls.length,
                preset_found: presetLinks.length,
                comments_detected: commentCount,
                cookie_used: !!cookie,
                elapsed_ms: elapsed
            },
            presets: presetLinks,
            all_links: allUrls.slice(0, 50)
        });

    } catch (err) {
        console.error('❌ Error:', err.message);
        if (browser) {
            try { await browser.close(); } catch {}
        }
        res.status(500).json({
            success: false,
            error: err.message,
            elapsed_ms: Date.now() - startedAt
        });
    }
});

// === ENDPOINT: DEBUG (buat lihat raw text) ===
app.get('/api/debug', async (req, res) => {
    const videoUrl = req.query.url;
    const cookie = req.query.cookie || process.env.TIKTOK_COOKIE || '';

    if (!videoUrl) {
        return res.status(400).json({ error: 'Parameter "url" wajib diisi' });
    }

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
            viewport: { width: 412, height: 915 },
            locale: 'id-ID'
        });

        if (cookie) {
            await context.addCookies(parseCookieString(cookie));
        }

        const page = await context.newPage();
        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        // Scroll
        for (let i = 0; i < 10; i++) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await page.waitForTimeout(2000);
        }

        const pageText = await page.evaluate(() => document.body.innerText);
        const pageHtml = await page.content();

        await browser.close();

        res.json({
            success: true,
            text_length: pageText.length,
            html_length: pageHtml.length,
            text_preview: pageText.slice(0, 3000),
            urls_found: (pageText.match(/https?:\/\/[^\s]+/g) || []).slice(0, 30)
        });

    } catch (err) {
        if (browser) await browser.close();
        res.status(500).json({ error: err.message });
    }
});

// === HEALTH CHECK ===
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'TikTok Preset Finder API',
        version: '1.1.0',
        endpoints: {
            preset: '/api/preset?url=<tiktok_url>&scroll=10&wait=3000',
            debug: '/api/debug?url=<tiktok_url>',
            health: '/health'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', uptime: process.uptime() });
});

// === START SERVER ===
app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
    console.log(`📌 Endpoint: /api/preset?url=<tiktok_url>`);
    console.log(`🐛 Debug: /api/debug?url=<tiktok_url>`);
});

// === HANDLE ERROR ===
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});
