const express = require('express');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');
const Velv = require("velv-js"); // Import the official VelvPay SDK
const { v4: uuidv4 } = require('uuid');

// --- 1. FIREBASE ADMIN SETUP ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());


// --- 2. VELVPAY SDK INITIALIZATION ---
const { VELVPAY_PUBLIC_KEY, VELVPAY_PRIVATE_KEY, VELVPAY_ENCRYPTION_KEY } = process.env;

if (!VELVPAY_PUBLIC_KEY || !VELVPAY_PRIVATE_KEY || !VELVPAY_ENCRYPTION_KEY) {
    console.error("FATAL ERROR: One or more VelvPay environment variables are missing.");
}

const velv = new Velv({
  secretKey: VELVPAY_PRIVATE_KEY,
  publicKey: VELVPAY_PUBLIC_KEY,
  encryptionKey: VELVPAY_ENCRYPTION_KEY,
});

console.log("Backend configured for VelvPay with velv-js SDK and Webhook.");


// --- 3. API ENDPOINTS ---

// A. PAYMENT INITIALIZATION
app.post('/payment/initialize', async (req, res) => {
    try {
        const { email, amount, callbackUrl } = req.body;

        // 1. Generate a unique reference ID
        const referenceId = `SF-${Date.now()}-${uuidv4()}`;

        // 2. Prepare payment request
        const response = await velv.initiatePayment({
            referenceId,
            body: {
                amount: Math.round(amount * 100), // amount in kobo
                title: "Payment for Smart Farmer",
                redirectUrl: callbackUrl || `https://smartfarmer.com/payment/confirmation?ref=${referenceId}`,
                description: "Smart Farmer Wallet Deposit"
            }
        });

        // 3. Store transaction request in Firestore before redirect
        await db.collection('transactions').add({
            email,
            referenceId,
            amount,
            status: 'Pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            details: "Initialized via VelvPay"
        });

        // 4. Format response for frontend
        const paymentData = {
            authorization_url: response.link || response.data?.link,
            short: response.short
        };

        res.status(200).json({
            status: true,
            message: "Authorization URL created",
            data: paymentData
        });

    } catch (error) {
        console.error('VelvPay SDK Initialization Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Failed to initialize payment with VelvPay.' });
    }
});

// B. WEBHOOK ENDPOINT with Full Logging
// B. WEBHOOK ENDPOINT with Full Logging and Status Update
app.post('/payment/webhook', async (req, res) => {
    try {
        console.log("=== VelvPay Webhook Received ===");
        console.log("Full Body:", JSON.stringify(req.body, null, 2));

        const webhookData = req.body.data;
        const referenceId = webhookData?.reference;
        const email = webhookData?.customer?.email;
        const amount = webhookData?.amount / 100;

        if (!referenceId || !email) {
            console.error("❌ Missing referenceId or email in webhook payload.");
            return res.status(400).send("Invalid webhook payload.");
        }

        // Check payment status
        let newStatus;
        if (req.body.event === 'charge.success' && webhookData?.status === 'success') {
            newStatus = 'Completed';

            // Update user's wallet balance
            const userQuery = await db.collection('users').where('email', '==', email).get();
            if (!userQuery.empty) {
                const userDoc = userQuery.docs[0];
                await db.collection('users').doc(userDoc.id).update({
                    walletBalance: admin.firestore.FieldValue.increment(amount)
                });
            } else {
                console.error(`⚠️ No user found with email: ${email}`);
            }

        } else if (webhookData?.status === 'failed') {
            newStatus = 'Failed';
        } else {
            newStatus = 'Pending';
        }

        // Update the existing transaction status
        const txnQuery = await db.collection('transactions').where('referenceId', '==', referenceId).get();
        if (!txnQuery.empty) {
            const txnDocId = txnQuery.docs[0].id;
            await db.collection('transactions').doc(txnDocId).update({
                status: newStatus,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                details: `Updated via VelvPay Webhook - ${newStatus}`
            });
            console.log(`✅ Transaction ${referenceId} updated to: ${newStatus}`);
        } else {
            console.warn(`⚠️ No transaction found for referenceId: ${referenceId}`);
        }

        res.status(200).send('Webhook processed successfully.');
    } catch (error) {
        console.error('❌ Error processing VelvPay webhook:', error);
        res.status(500).send('Error processing webhook.');
    }
});

// C. WITHDRAWAL ENDPOINT (With Demo and Live Mode)


// D. OTHER ADMIN & SYSTEM ENDPOINTS (These have no changes)
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

// --- 5. START THE SERVER ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));