require('dotenv').config();
const express = require('express');
const path = require('path');
const CyberSource = require('cybersource-rest-client');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const CYBS_HOST = 'apitest.cybersource.com';

function makeSdkConfig() {
  return {
    authenticationType: 'http_signature',
    merchantID: process.env.MERCHANT_ID,
    merchantKeyId: process.env.KEY_ID,
    merchantsecretKey: process.env.SHARED_SECRET,
    runEnvironment: CYBS_HOST,
    logConfiguration: { enableLog: false },
  };
}


// POST /api/session — generates a capture context JWT via the CyberSource SDK.
//
// Edit captureContext below to change what is sent to CyberSource.
// The browser passes { totalAmount, currency } to slot into amountDetails.
app.post('/api/session', (req, res) => {
  const { totalAmount = '21.12', currency = 'USD' } = req.body;

  const requestObj = new CyberSource.GenerateUnifiedCheckoutCaptureContextRequest();
  requestObj.clientVersion = '0.26'; // 0.x flow: official sample uses 0.26
  // VAS 1.0.0 flow: replace with a clientVersion that produces iframes.orc in the JWT.
  // No known public value exists yet — contact CyberSource support to have it enabled.
  requestObj.targetOrigins = [process.env.ORIGIN_URL || `http://localhost:${PORT}`];
  requestObj.allowedCardNetworks = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'];
  requestObj.allowedPaymentTypes = ['PANENTRY'];
  requestObj.country = 'US';
  requestObj.locale = 'en_US';
  requestObj.buttonType = 'CHECKOUT';

  const captureMandate = new CyberSource.Upv1capturecontextsCaptureMandate();
  captureMandate.billingType = 'FULL';
  captureMandate.requestEmail = true;
  captureMandate.requestPhone = false;
  captureMandate.requestShipping = false;
  captureMandate.showAcceptedNetworkIcons = true;
  requestObj.captureMandate = captureMandate;

  const completeMandate = new CyberSource.Upv1capturecontextsCompleteMandate();
  completeMandate.type = 'CAPTURE';
  requestObj.completeMandate = completeMandate;

  const data = new CyberSource.Upv1capturecontextsData();

  const orderInfo = new CyberSource.Upv1capturecontextsOrderInformation();
  const amountDetails = new CyberSource.Upv1capturecontextsOrderInformationAmountDetails();
  amountDetails.totalAmount = totalAmount;
  amountDetails.currency = currency;
  orderInfo.amountDetails = amountDetails;
  data.orderInformation = orderInfo;

  const mdi = new CyberSource.Upv1capturecontextsDataMerchantDefinedInformation();
  mdi.key = '1';
  mdi.value = '1fbf5bd8-028f-4c9f-bce5-6f79cd75584e';
  data.merchantDefinedInformation = [mdi];

  requestObj.data = data;

  const api = new CyberSource.UnifiedCheckoutCaptureContextApi(makeSdkConfig());

  api.generateUnifiedCheckoutCaptureContext(requestObj, (error, data, response) => {
    if (error) {
      console.error('SDK error:', error);
      return res.status(500).json({ error: String(error) });
    }
    // Extract clientLibrary URL from the JWT so the browser loads the right script
    let clientLibrary = null;
    try {
      const payload = JSON.parse(Buffer.from(data.split('.')[1], 'base64url').toString());
      const ctx = payload?.ctx?.[0]?.data ?? {};
      clientLibrary = ctx.clientLibrary ?? null;
      var clientLibraryIntegrity = ctx.clientLibraryIntegrity ?? null;
    } catch (e) { /* ignore */ }
    res.json({ sessionJWT: data, clientLibrary, clientLibraryIntegrity });
  });
});

// POST /api/pay — submits the transient token JWT from Unified Checkout to the Payments API.
// The browser sends { transientTokenJwt, totalAmount, currency } after the customer completes checkout.
app.post('/api/pay', (req, res) => {
  const { transientTokenJwt, totalAmount = '1.00', currency = 'USD' } = req.body;
  if (!transientTokenJwt) {
    return res.status(400).json({ error: 'transientTokenJwt is required' });
  }

  const requestObj = new CyberSource.CreatePaymentRequest();

  const clientRef = new CyberSource.Ptsv2paymentsClientReferenceInformation();
  clientRef.code = `order-${Date.now()}`;
  requestObj.clientReferenceInformation = clientRef;

  const tokenInfo = new CyberSource.Ptsv2paymentsTokenInformation();
  tokenInfo.transientTokenJwt = transientTokenJwt;
  requestObj.tokenInformation = tokenInfo;

  const orderInfo = new CyberSource.Ptsv2paymentsOrderInformation();
  const amountDetails = new CyberSource.Ptsv2paymentsOrderInformationAmountDetails();
  amountDetails.totalAmount = totalAmount;
  amountDetails.currency = currency;
  orderInfo.amountDetails = amountDetails;
  requestObj.orderInformation = orderInfo;

  const mdiEntries = [
    { key: '1', value: '1fbf5bd8-028f-4c9f-bce5-6f79cd75584e' },
    { key: '2', value: 'a3c72e91-1d4b-4f8a-b5e6-9d0c3f2a1b7e' },
    { key: '3', value: 'f8b4d620-7e3a-4c91-a2f5-1b8e0d6c9a3f' },
    { key: '4', value: '2d9f1a84-5c7b-4e02-b3d6-8a1f0e4c7b9d' },
  ];
  requestObj.merchantDefinedInformation = mdiEntries.map(({ key, value }) => {
    const mdi = new CyberSource.Ptsv2paymentsMerchantDefinedInformation();
    mdi.key = key;
    mdi.value = value;
    return mdi;
  });

  const api = new CyberSource.PaymentsApi(makeSdkConfig());
  api.createPayment(requestObj, (error, data, response) => {
    if (error) {
      console.error('Payment error:', error);
      return res.status(500).json({ error: String(error) });
    }
    console.log('Payment response:', JSON.stringify(data, null, 2));
    res.json({
      status:          data.status,
      id:              data.id,
      reconciliationId: data.reconciliationId,
      errorInformation: data.errorInformation ?? null,
    });
  });
});

// GET /api/transaction/:id — retrieves full transaction details including merchantDefinedInformation.
app.get('/api/transaction/:id', (req, res) => {
  const api = new CyberSource.TransactionDetailsApi(makeSdkConfig());
  api.getTransaction(req.params.id, (error, data) => {
    if (error) return res.status(500).json({ error: String(error) });
    res.json(data);
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Merchant ID: ${process.env.MERCHANT_ID || '(not set — copy .env.example to .env)'}`);
});
