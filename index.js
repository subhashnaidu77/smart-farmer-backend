const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');

const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

const ERCASPAY_SECRET_KEY = process.env.ERCASPAY_SECRET_KEY;
const API_BASE_URL = 'https://api.paystack.co';

// --- THIS IS THE UPDATED ENDPOINT ---
app.post('/payment/initialize', async (req, res) => {
    try {
        // We now receive the callbackUrl from the frontend
        const { email, amount, callbackUrl } = req.body;

        const response = await axios.post(`${API_BASE_URL}/transaction/initialize`, {
            email: email,
            amount: Math.round(amount * 100),
            callback_url: callbackUrl // Use the URL sent from the frontend
        }, {
            headers: { Authorization: `Bearer ${ERCASPAY_SECRET_KEY}` }
        });
        
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Payment Initialization Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Failed to initialize payment.' });
    }
});

app.get('/payment/verify/:reference', async (req, res) => {
    try {
        const { reference } = req.params;
        const response = await axios.get(`${API_BASE_URL}/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${ERCASPAY_SECRET_KEY}` } });
        const { status, amount, customer } = response.data.data;
        if (status === 'success') {
            const userQuerySnapshot = await db.collection('users').where('email', '==', customer.email).get();
            if (userQuerySnapshot.empty) { return res.status(404).json({ message: 'User not found.' }); }
            const userDoc = userQuerySnapshot.docs[0];
            const userId = userDoc.id;
            const amountInMainUnit = amount / 100;
            await db.collection('users').doc(userId).update({ walletBalance: admin.firestore.FieldValue.increment(amountInMainUnit) });
            await db.collection('transactions').add({ userId: userId, type: 'Deposit', amount: amountInMainUnit, status: 'Completed', createdAt: admin.firestore.FieldValue.serverTimestamp(), details: `Deposit via ErcasPay. Reference: ${reference}` });
            res.status(200).json({ message: 'Payment verified successfully.' });
        } else {
            res.status(400).json({ message: 'Payment verification failed.' });
        }
    } catch (error) { res.status(500).json({ message: 'Error during payment verification.' }); }
});

// All other admin and system endpoints remain the same
app.get('/admin/users', async (req, res) => { /* ... */ });
app.post('/admin/users/setrole', async (req, res) => { /* ... */ });
app.delete('/admin/users/:uid', async (req, res) => { /* ... */ });
app.get('/admin/withdrawals', async (req, res) => { /* ... */ });
app.post('/admin/withdrawals/update', async (req, res) => { /* ... */ });
app.get('/admin/transactions', async (req, res) => { /* ... */ });
app.post('/system/process-payouts', async (req, res) => { /* ... */ });


app.get('/', (req, res) => res.send('Smart Farmer Backend is LIVE!'));
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));