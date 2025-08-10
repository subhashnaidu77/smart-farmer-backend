const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const CryptoJS = require("crypto-js"); // For encryption
const { v4: uuidv4 } = require('uuid'); // For unique reference IDs

// --- 1. FIREBASE ADMIN SETUP ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());


// --- 2. VELVPAY API CONFIG ---
const { VELVPAY_PUBLIC_KEY, VELVPAY_PRIVATE_KEY, VELVPAY_ENCRYPTION_KEY } = process.env;
const API_BASE_URL = 'https://api.velvpay.com/api/v1/service';

console.log("Backend configured for VelvPay.");


// --- 3. HELPER FUNCTION TO GENERATE VELVPAY HEADERS ---
const generateVelvPayHeaders = () => {
    const referenceId = uuidv4();
    const authorizationString = VELVPAY_PRIVATE_KEY + VELVPAY_PUBLIC_KEY + referenceId;
    const encryptedToken = CryptoJS.AES.encrypt(authorizationString, VELVPAY_ENCRYPTION_KEY).toString();

    return {
        'api-key': encryptedToken,
        'public-key': VELVPAY_PUBLIC_KEY,
        'reference-id': referenceId,
        'Content-Type': 'application/json'
    };
};


// --- 4. API ENDPOINTS ---

// A. PAYMENT ENDPOINTS
app.post('/payment/initialize', async (req, res) => {
    try {
        const { email, amount, callbackUrl } = req.body;
        
        // As per VelvPay docs, we use the /payment/cash-craft/initiate endpoint
        const payload = {
            amount: Math.round(amount * 100),
            email: email,
            isNaira: false, // This means amount is in kobo
            callback_url: callbackUrl,
            description: "Smart Farmer Wallet Deposit"
            // Beneficiaries are not needed for a simple wallet deposit
        };
        
        const headers = generateVelvPayHeaders();

        const response = await axios.post(`${API_BASE_URL}/payment/cash-craft/initiate`, payload, { headers });
        
        // Adapt the response to provide a payment link to the frontend
        // VelvPay's response structure might be different, this is an assumption
        const paymentData = {
            authorization_url: response.data.data.link || `https://some-velvpay-payment-page.com/${response.data.data.reference}`,
            access_code: response.data.data.reference,
            reference: response.data.data.reference
        };

        res.status(200).json({ status: true, message: "Authorization URL created", data: paymentData });

    } catch (error) {
        console.error('VelvPay Initialization Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Failed to initialize payment with VelvPay.' });
    }
});

app.get('/payment/verify/:reference', async (req, res) => {
    try {
        const { reference } = req.params;
        const headers = generateVelvPayHeaders();

        // The endpoint from the docs is /payment/cash-craft/resolve
        const response = await axios.get(`${API_BASE_URL}/payment/cash-craft/resolve?txId=${reference}`, { headers });
        
        // This part needs to be adapted based on VelvPay's actual verification response
        const { status, amount, metadata } = response.data.data; // Assuming this structure

        if (status === 'success' || status === 'completed') {
            const userEmail = metadata.find(m => m.email)?.email;
            if (!userEmail) { throw new Error("User email not found in transaction metadata"); }

            const userQuerySnapshot = await db.collection('users').where('email', '==', userEmail).get();
            if (userQuerySnapshot.empty) { return res.status(404).json({ message: 'User not found.' }); }
            const userDoc = userQuerySnapshot.docs[0];
            const userId = userDoc.id;
            const amountInMainUnit = amount / 100;

            await db.collection('users').doc(userId).update({ walletBalance: admin.firestore.FieldValue.increment(amountInMainUnit) });
            await db.collection('transactions').add({ userId: userId, type: 'Deposit', amount: amountInMainUnit, status: 'Completed', createdAt: admin.firestore.FieldValue.serverTimestamp(), details: `Deposit via VelvPay. Reference: ${reference}` });
            
            res.status(200).json({ message: 'Payment verified successfully.' });
        } else {
            res.status(400).json({ message: 'Payment verification failed.' });
        }
    } catch (error) {
        console.error('VelvPay Verification Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Error during payment verification.' });
    }
});


// B. ADMIN & SYSTEM ENDPOINTS (These sections have no changes)
app.get('/admin/users', async (req, res) => {
    try {
        const userRecords = await admin.auth().listUsers(1000);
        const usersPromises = userRecords.users.map(async (user) => {
            const userDoc = await db.collection('users').doc(user.uid).get();
            return { uid: user.uid, email: user.email, disabled: user.disabled, createdAt: user.metadata.creationTime, role: userDoc.exists ? userDoc.data().role : 'user' };
        });
        const users = await Promise.all(usersPromises);
        res.status(200).json(users);
    } catch (error) { res.status(500).json({ message: 'Failed to list users.' }); }
});

app.post('/admin/users/setrole', async (req, res) => {
    try {
        const { uid, role } = req.body;
        await admin.auth().setCustomUserClaims(uid, { role: role });
        await db.collection('users').doc(uid).update({ role: role });
        res.status(200).json({ message: `Successfully set user role to ${role}` });
    } catch (error) { res.status(500).json({ message: 'Failed to set user role.' }); }
});

app.delete('/admin/users/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        await admin.auth().deleteUser(uid);
        await db.collection('users').doc(uid).delete();
        res.status(200).json({ message: 'User deleted successfully.' });
    } catch (error) { res.status(500).json({ message: 'Failed to delete user.' }); }
});

app.get('/admin/withdrawals', async (req, res) => {
    try {
        const snapshot = await db.collection('withdrawals').orderBy('createdAt', 'desc').get();
        const withdrawals = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json(withdrawals);
    } catch (error) {
        console.error('Error fetching withdrawals:', error);
        res.status(500).json({ message: 'Failed to fetch withdrawal requests.' });
    }
});

app.post('/admin/withdrawals/update', async (req, res) => {
    try {
        const { id, status } = req.body;
        if (!id || !status) { return res.status(400).json({ message: 'Request ID and status are required.' }); }
        
        const withdrawalRef = db.collection('withdrawals').doc(id);
        const withdrawalDoc = await withdrawalRef.get();
        if (!withdrawalDoc.exists) { return res.status(404).json({ message: 'Withdrawal request not found.' }); }

        if (status === 'approved') {
            const withdrawalData = withdrawalDoc.data();
            const { amount, userId } = withdrawalData;
            
            console.log(`--- SIMULATING PAYOUT FOR USER ${userId} ---`);

            const userRef = db.collection('users').doc(userId);
            const userDoc = await userRef.get();
            if (!userDoc.exists) { return res.status(404).json({ message: 'User not found.' }); }

            if (userDoc.data().walletBalance < amount) {
                await withdrawalRef.update({ status: 'failed', notes: 'Insufficient balance at time of approval.' });
                return res.status(400).json({ message: 'User has insufficient balance.' });
            }
            await userRef.update({ walletBalance: admin.firestore.FieldValue.increment(-amount) });
            await withdrawalRef.update({ status: 'approved', processedAt: admin.firestore.FieldValue.serverTimestamp() });
            await db.collection('transactions').add({
                userId: userId,
                type: 'Withdrawal',
                amount: amount,
                status: 'Completed',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                details: `Withdrawal to ${withdrawalData.bankDetails.bankName}`
            });
            console.log(`--- PAYOUT SIMULATION FOR USER ${userId} SUCCEEDED ---`);
        } else {
            await withdrawalRef.update({ status: status });
        }
        res.status(200).json({ message: `Withdrawal request has been successfully marked as ${status}.` });
    } catch (error) {
        console.error('Error updating withdrawal:', error);
        res.status(500).json({ message: 'Failed to process withdrawal request.' });
    }
});

app.get('/admin/transactions', async (req, res) => {
    try {
        const snapshot = await db.collection('transactions').orderBy('createdAt', 'desc').get();
        const transactionsPromises = snapshot.docs.map(async (doc) => {
            const transaction = { id: doc.id, ...doc.data() };
            const userRecord = await admin.auth().getUser(transaction.userId);
            return { ...transaction, email: userRecord.email };
        });
        const transactions = await Promise.all(transactionsPromises);
        res.status(200).json(transactions);
    } catch (error) { res.status(500).json({ message: 'Failed to fetch transactions.' }); }
});

app.post('/system/process-payouts', async (req, res) => {
    try {
        const now = new Date();
        const investmentsRef = db.collection('investments');
        const snapshot = await investmentsRef.where('status', '==', 'active').get();
        if (snapshot.empty) { return res.status(200).json({ message: 'No active investments to process.' }); }
        let processedCount = 0;
        const batch = db.batch();
        for (const doc of snapshot.docs) {
            const investment = doc.data();
            const investmentDate = investment.createdAt.toDate();
            const projectDoc = await db.collection('projects').doc(investment.projectId).get();
            if (!projectDoc.exists) continue;
            const project = projectDoc.data();
            const durationDays = project.durationDays;
            const maturityDate = new Date(investmentDate);
            maturityDate.setDate(maturityDate.getDate() + durationDays);
            if (now >= maturityDate) {
                const profit = investment.amount * (project.returnPercentage / 100);
                const payoutAmount = investment.amount + profit;
                const userRef = db.collection('users').doc(investment.userId);
                const investmentRef = doc.ref;
                batch.update(userRef, { walletBalance: admin.firestore.FieldValue.increment(payoutAmount) });
                batch.update(investmentRef, { status: 'completed' });
                processedCount++;
            }
        }
        await batch.commit();
        const message = `Payout process completed. Processed ${processedCount} matured investments.`;
        console.log(message);
        res.status(200).json({ message });
    } catch (error) {
        console.error('Error processing payouts:', error);
        res.status(500).json({ message: 'An error occurred during payout processing.' });
    }
});

app.get('/', (req, res) => res.send('Smart Farmer Backend is LIVE!'));

// --- 4. START THE SERVER ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));