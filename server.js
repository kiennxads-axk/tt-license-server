const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const NodeRSA = require('node-rsa');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load Config
// Simulating Database with JSON file
const DB_FILE = path.join(__dirname, 'orders.json');
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}));

// Load Private Key
let privateKey;
if (process.env.PRIVATE_KEY) {
    // Load from Environment Variable (For Cloud/Render)
    privateKey = new NodeRSA(process.env.PRIVATE_KEY.replace(/\\n/g, '\n'), 'pkcs8-private'); // Handle newline
} else {
    // Load from File (For Localhost)
    const privateKeyPath = path.join(__dirname, 'keys', 'private.pem');
    if (fs.existsSync(privateKeyPath)) {
        privateKey = new NodeRSA(fs.readFileSync(privateKeyPath, 'utf8'));
    } else {
        console.error("FATAL: Private key not found in ENV or File!");
        // process.exit(1); // Don't crash on dev if missing, but will fail later
    }
}

// Utils
function saveOrder(orderId, data) {
    // Trên Cloud (Render), file system là ephemeral (tạm thời), sẽ mất khi restart.
    // Tốt nhất nên dùng Database thật (MongoDB/PostgreSQL).
    // Nhưng để demo đơn giản, ta vẫn dùng file, chấp nhận mất data khi redeploy.
    const dbFile = path.join('/tmp', 'orders.json'); // Use /tmp for write permission on some clouds
    // Hoặc fallback về local
    const targetFile = fs.existsSync('/tmp') ? dbFile : DB_FILE;

    let db = {};
    if (fs.existsSync(targetFile)) {
        try { db = JSON.parse(fs.readFileSync(targetFile, 'utf8')); } catch (e) { }
    }
    db[orderId] = { ...data, status: 'PENDING', createdAt: new Date().toISOString() };
    fs.writeFileSync(targetFile, JSON.stringify(db, null, 2));
}

function getOrder(orderId) {
    const dbFile = path.join('/tmp', 'orders.json');
    const targetFile = fs.existsSync('/tmp') ? dbFile : DB_FILE;
    if (!fs.existsSync(targetFile)) return null;
    const db = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    return db[orderId];
}

function updateOrderStatus(orderId, status, extraData = {}) {
    const dbFile = path.join('/tmp', 'orders.json');
    const targetFile = fs.existsSync('/tmp') ? dbFile : DB_FILE;
    if (fs.existsSync(targetFile)) {
        const db = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
        if (db[orderId]) {
            db[orderId] = { ...db[orderId], status, ...extraData, updatedAt: new Date().toISOString() };
            fs.writeFileSync(targetFile, JSON.stringify(db, null, 2));
        }
    }
}

function generateLicense(machineId, type) {
    if (!privateKey) throw new Error("Private Key not configured!");
    const machineHash = machineId.substring(0, 8).toUpperCase();
    const now = new Date();
    let expiry = '';

    if (type === 'M') now.setMonth(now.getMonth() + 1);
    else if (type === 'Y') now.setFullYear(now.getFullYear() + 1);
    else if (type === 'P') expiry = 'FOREVER';

    if (type !== 'P') {
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        expiry = `${yyyy}${mm}${dd}`;
    }

    const payload = `${type}-${machineHash}-${expiry}`;
    const signature = privateKey.sign(payload, 'base64', 'utf8');
    return `${payload}-${signature}`;
}

async function sendEmail(to, licenseKey, orderId) {
    // Config SMTP from Env or Default
    const user = process.env.EMAIL_USER || 'kiennx.ads@gmail.com';
    const pass = process.env.EMAIL_PASS || 'YOUR_APP_PASSWORD';

    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user, pass },
        tls: {
            ciphers: 'SSLv3'
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
        logger: true,
        debug: true
    });

    const mailOptions = {
        from: '"TT Open Manager" <kiennx.ads@gmail.com>',
        to: to,
        subject: `[TT Open Manager] License Key cho đơn hàng #${orderId}`,
        text: `Cảm ơn bạn đã mua bản quyền!\n\nLicense Key của bạn là:\n${licenseKey}\n\nHướng dẫn: Copy key trên và nhập vào phần mềm để kích hoạt.`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #0284c7;">Cảm ơn bạn đã sử dụng TT Open Manager!</h2>
                <p>Đơn hàng <b>#${orderId}</b> của bạn đã được xác nhận.</p>
                <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; border: 1px solid #bae6fd;">
                    <p style="margin: 0; color: #0c4a6e; font-size: 14px;">License Key của bạn:</p>
                    <p style="margin: 10px 0; font-family: monospace; font-size: 16px; font-weight: bold; word-break: break-all; color: #0369a1;">
                        ${licenseKey}
                    </p>
                </div>
                <p><b>Hướng dẫn kích hoạt:</b></p>
                <ol>
                    <li>Mở phần mềm TT Open Manager</li>
                    <li>Copy License Key ở trên</li>
                    <li>Dán vào ô nhập License Key và bấm Kích hoạt</li>
                </ol>
                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
                <p style="font-size: 12px; color: #6b7280;">Nếu cần hỗ trợ, vui lòng reply email này.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email sent to ${to}`);
        return true;
    } catch (error) {
        console.error("Email error:", error);
        return false;
    }
}

// Routes
// app.get('/', (req, res) => {
//     res.sendFile(path.join(__dirname, 'public', 'index.html'));
// });

// 1. Tạo đơn hàng
app.post('/create-order', (req, res) => {
    const { machineId, email, type, amount } = req.body;
    if (!machineId || !email || !type || !amount) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Generate Order ID (VD: TT + 4 số ngẫu nhiên)
    const orderId = 'TT' + Math.floor(1000 + Math.random() * 9000);

    saveOrder(orderId, { machineId, email, type, amount });

    res.json({
        success: true,
        orderId,
        message: `Vui lòng chuyển khoản ${amount}đ với nội dung: ${orderId}`
    });
});

// 2. Webhook nhận thanh toán (từ SePay/VietQR/Cassio)
app.post('/webhook/sepay', async (req, res) => {
    // Cấu trúc webhook phụ thuộc vào cổng thanh toán bên thứ 3
    // Giả sử SePay gửi: { content: "TT1234", amount: 200000, ... }

    try {
        const { content, amount } = req.body;
        console.log("Received Webhook:", req.body);

        // Tìm Order ID trong nội dung chuyển khoản
        // Regex tìm chuỗi TTxxxx
        const match = content.match(/TT\d{4}/);
        if (!match) {
            return res.json({ success: false, message: "No order code found" });
        }

        const orderId = match[0];
        const order = getOrder(orderId);

        if (!order) {
            console.log(`Order ${orderId} not found`);
            return res.json({ success: false, message: "Order not found" });
        }

        if (order.status === 'COMPLETED') {
            return res.json({ success: true, message: "Order already completed" });
        }

        // Kiểm tra số tiền (cho phép sai số nhỏ hoặc chính xác)
        if (parseFloat(amount) < parseFloat(order.amount)) {
            return res.json({ success: false, message: "Insufficient amount" });
        }

        // Generate License
        const licenseKey = generateLicense(order.machineId, order.type);

        // Update Order
        updateOrderStatus(orderId, 'COMPLETED', { licenseKey });

        // Send Email
        const emailSent = await sendEmail(order.email, licenseKey, orderId);

        res.json({ success: true, emailSent });

    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.listen(PORT, () => {
    console.log(`License Server running on port ${PORT}`);
});
