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

// === ENDPOINT UTAMA ===
app.get('/api/preset', async (req, res) => {
    const videoUrl = req.query.url;
    const maxScroll = parseInt(req.query.scroll) || 5;

    if (!videoUrl) {
        return res.status(400).json({
            success: false,
            error: 'Parameter "url" wajib diisi. Contoh: /api/preset?url=https://vt.tiktok.com/xxx/'
        });
    }

    // Validasi URL TikTok
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

        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
            viewport: { width: 412, height: 915 },
            locale: 'id-ID'
        });

        const page = await context.newPage();

        console.log('📥 Membuka halaman TikTok...');
        await page.goto(videoUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // Tunggu konten keload
        await page.waitForTimeout(3000);

        // Scroll buat load komentar
        console.log(`📜 Scroll ${maxScroll} kali...`);
        for (let i = 0; i < maxScroll; i++) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await page.waitForTimeout(2000);
        }

        // Ambil semua text dari halaman
        const pageText = await page.evaluate(() => document.body.innerText);

        // Ambil semua link dari elemen <a>
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

        await browser.close();
        browser = null;

        // Extract URLs dari text
        const textUrls = pageText.match(/https?:\/\/[^\s]+/g) || [];
        const allUrls = [...new Set([...textUrls, ...hrefLinks])];

        // Filter Alight Motion
        const presetLinks = allUrls.filter(isAlightUrl);

        // Ambil judul/caption video
        const caption = await page.evaluate(() => {
            const meta = document.querySelector('meta[property="og:description"]');
            return meta ? meta.content : '';
        }).catch(() => '');

        const elapsed = Date.now() - startedAt;

        console.log(`✅ Selesai dalam ${elapsed}ms - ${presetLinks.length} preset ditemukan`);

        res.json({
            success: true,
            video: {
                url: videoUrl,
                caption: caption || null
            },
            scan: {
                total_links: allUrls.length,
                preset_found: presetLinks.length,
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

// === HEALTH CHECK ===
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'TikTok Preset Finder API',
        version: '1.0.0',
        endpoints: {
            preset: '/api/preset?url=<tiktok_url>&scroll=5',
            health: '/'
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
});

// === HANDLE ERROR ===
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});