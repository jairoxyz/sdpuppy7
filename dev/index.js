import express from 'express';
import { getSrc } from './plresolver.js';

const app = express();
app.use(express.json());

app.get('/get', async (req, res) => {
  try {
    let embedUrl = req.query.url;
    let referer = req.query.referer;
    if (!embedUrl || embedUrl === "") {
      res.status(500).json({ 'Error': 'No URL provided.' });
      return;
    } else {
      try {
        new URL(decodeURI(embedUrl));
      } catch (e) {
        res.status(500).json({ 'Error': 'Invalid URL provided.' });
        return;
      }
    }
    embedUrl = decodeURI(embedUrl);
    referer = decodeURI(referer);
    const result = await getSrc(embedUrl, referer, 15000);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ Error: 'Internal server error' });
  }
});

// 404 Middleware
app.use((req, res) => {
  res.status(404).json({ Error: 'Invalid API request' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`SD Puppy7 running on port ${port}`);
});
