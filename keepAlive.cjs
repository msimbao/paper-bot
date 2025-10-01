// keepAlive.js

const https = require("https");

const URL = "https://your-render-app.onrender.com"; // Replace with your Render app URL
const INTERVAL = 10 * 60 * 1000; // 10 minutes in milliseconds

function ping() {
    https.get(URL, (res) => {
        console.log(`[${new Date().toISOString()}] Pinged ${URL} - Status: ${res.statusCode}`);
        res.on("data", () => {}); // consume data so connection closes cleanly
    }).on("error", (err) => {
        console.error(`[${new Date().toISOString()}] Error pinging ${URL}:`, err.message);
    });
}

console.log("🚀 Keep-alive script started.");
ping(); // ping immediately
setInterval(ping, INTERVAL); // ping every 10 minutes