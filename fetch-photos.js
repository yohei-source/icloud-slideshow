#!/usr/bin/env node
// iCloud共有アルバムから写真URLを取得してdocs/photos.jsonに書き出す

const https = require('https');
const fs = require('fs');
const path = require('path');

const ALBUM_TOKEN = process.env.ALBUM_TOKEN || 'B2V532ODWJ5P8ye';

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.icloud.com',
        'User-Agent': 'Mozilla/5.0',
      },
    };
    const req = https.request(options, (res) => {
      // Handle iCloud 330 redirect
      if (res.statusCode === 330) {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const redirect = JSON.parse(data);
            const newHost = redirect['X-Apple-MMe-Host'];
            if (newHost) {
              const newUrl = `https://${newHost}${parsed.pathname}`;
              console.log(`330 redirect -> ${newHost}`);
              resolve(httpsPost(newUrl, body));
            } else {
              reject(new Error('330 response without redirect host'));
            }
          } catch (e) {
            reject(e);
          }
        });
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function buildPhotoUrl(derivative) {
  // derivative has checksum and urlLocation
  return `https://${derivative.urlLocation}${derivative.urlPath}`;
}

async function main() {
  const baseUrl = `https://p46-sharedstreams.icloud.com/${ALBUM_TOKEN}/sharedstreams`;

  console.log('Fetching webstream...');
  const stream = await httpsPost(`${baseUrl}/webstream`, { streamCtag: null });

  const photos = stream.photos || [];
  console.log(`Found ${photos.length} photos`);

  if (photos.length === 0) {
    console.log('No photos found. Writing empty array.');
    fs.writeFileSync(
      path.join(__dirname, 'docs', 'photos.json'),
      JSON.stringify([], null, 2)
    );
    return;
  }

  // Collect all photo GUIDs
  const guids = photos.map((p) => p.photoGuid);

  // Fetch asset URLs in batches of 25
  const allAssets = [];
  for (let i = 0; i < guids.length; i += 25) {
    const batch = guids.slice(i, i + 25);
    console.log(`Fetching assets ${i + 1}-${i + batch.length}...`);
    const assets = await httpsPost(`${baseUrl}/webasseturls`, {
      photoGuids: batch,
    });

    if (assets.items) {
      for (const [checksum, item] of Object.entries(assets.items)) {
        allAssets.push({
          checksum,
          url: `https://${item.url_location}${item.url_path}`,
        });
      }
    }
  }

  // Match photos with their best-quality derivative
  const result = [];
  for (const photo of photos) {
    const derivatives = photo.derivatives || {};
    // Pick largest derivative (highest pixel count)
    let best = null;
    let bestPixels = 0;
    for (const [key, deriv] of Object.entries(derivatives)) {
      const pixels = (parseInt(deriv.width) || 0) * (parseInt(deriv.height) || 0);
      if (pixels > bestPixels) {
        bestPixels = pixels;
        best = deriv;
      }
    }
    if (best && best.checksum) {
      // Find matching asset URL
      const asset = allAssets.find((a) => a.checksum === best.checksum);
      if (asset) {
        result.push({
          guid: photo.photoGuid,
          url: asset.url,
          width: parseInt(best.width) || 0,
          height: parseInt(best.height) || 0,
          caption: photo.caption || '',
          date: photo.dateCreated || '',
        });
      }
    }
  }

  console.log(`Resolved ${result.length} photo URLs`);

  const outPath = path.join(__dirname, 'docs', 'photos.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Written to ${outPath}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
