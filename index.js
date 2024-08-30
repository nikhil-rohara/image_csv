const express = require('express');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const Queue = require('bull');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
app.use(express.json());

// MySQL connection
const db = await mysql.createConnection({
    host: 'localhost',
    user: 'your_username',
    password: 'your_password',
    database: 'image_processing'
});

// Redis queue
const imageQueue = new Queue('image processing', {
    redis: { port: 6379, host: '127.0.0.1' }
});

// Multer configuration for CSV file uploads
const upload = multer({ dest: 'uploads/' });

// Upload API
app.post('/upload', upload.single('file'), async (req, res) => {
    const requestId = uuidv4();
    const filePath = req.file.path;

    // Store request in database
    await db.execute('INSERT INTO processing_requests (request_id, status) VALUES (?, ?)', [requestId, 'PENDING']);

    // Add job to queue
    await imageQueue.add({ requestId, filePath });

    res.json({ requestId });
});

// Status API
app.get('/status/:requestId', async (req, res) => {
    const [rows] = await db.execute('SELECT status FROM processing_requests WHERE request_id = ?', [req.params.requestId]);

    if (rows.length > 0) {
        res.json({ status: rows[0].status });
    } else {
        res.status(404).json({ error: 'Request ID not found' });
    }
});

// Webhook endpoint (optional)
app.post('/webhook', async (req, res) => {
    console.log('Webhook received:', req.body);
    res.sendStatus(200);
});

// Worker to process images
imageQueue.process(async (job) => {
    const { requestId, filePath } = job.data;

    try {
        await db.execute('UPDATE processing_requests SET status = ? WHERE request_id = ?', ['PROCESSING', requestId]);

        // Read and process CSV
        const csv = fs.readFileSync(filePath, 'utf8');
        const lines = csv.split('\n').filter(line => line.trim());

        const processedImages = [];

        for (let i = 1; i < lines.length; i++) {
            const [serialNumber, productName, inputUrls] = lines[i].split(',');

            const inputUrlsArray = inputUrls.split(';');
            const outputUrlsArray = [];

            for (let url of inputUrlsArray) {
                const imageResponse = await axios.get(url, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(imageResponse.data, 'binary');

                const outputFilePath = path.join(__dirname, 'uploads', `output-${uuidv4()}.jpg`);

                await sharp(buffer)
                    .jpeg({ quality: 50 })
                    .toFile(outputFilePath);

                outputUrlsArray.push(outputFilePath);
            }

            processedImages.push({
                productName,
                inputUrls: inputUrlsArray.join(';'),
                outputUrls: outputUrlsArray.join(';')
            });
        }

        // Store processed image data in the database
        for (let img of processedImages) {
            await db.execute(
                'INSERT INTO processed_images (request_id, product_name, input_urls, output_urls) VALUES (?, ?, ?, ?)',
                [requestId, img.productName, img.inputUrls, img.outputUrls]
            );
        }

        // Update request status to COMPLETED
        await db.execute('UPDATE processing_requests SET status = ? WHERE request_id = ?', ['COMPLETED', requestId]);

        // Optionally trigger webhook
        // axios.post('https://your-webhook-url.com', { requestId, status: 'COMPLETED' });

    } catch (error) {
        console.error('Error processing images:', error);
        await db.execute('UPDATE processing_requests SET status = ? WHERE request_id = ?', ['FAILED', requestId]);
    } finally {
        // Cleanup
        fs.unlinkSync(filePath);
    }
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});
