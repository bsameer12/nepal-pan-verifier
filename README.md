# Nepal PAN Verifier API (Serverless)

A 100% free, serverless microservice to verify Nepalese Permanent Account Numbers (PAN) and tax clearance statuses directly from the **Inland Revenue Department (IRD) of Nepal** (`ird.gov.np`).

Deployable in 1 click to **Vercel** or **Render** for free.

---

## Features
- **100% Free**: Zero subscription or API keys required.
- **Serverless**: Uses `@sparticuz/chromium-min` on AWS Lambda / Vercel with zero server overhead.
- **Automated reCAPTCHA Bypass**: Solves Google Invisible reCAPTCHA naturally in the cloud browser session.
- **Full Statutory Details**: Returns Trade Name (English & Nepali), Tax Office (IRO/LTO), Address, Ward, Effective Reg Date, VAT Filing Period, Income Tax Filing Period, and Tax Clearance Fiscal Year & Return Verified Date.

---

## 1-Click Free Deployment on Vercel

1. Fork or push this repository to your GitHub account.
2. Sign in to **[Vercel](https://vercel.com)** with GitHub.
3. Click **Add New...** $\rightarrow$ **Project**.
4. Select this repository and click **Deploy**.
5. Once deployed, you get an endpoint:
   ```
   https://your-project.vercel.app/api/pan?pan=122782196
   ```

---

## API Usage

### Endpoint
`GET /api/pan?pan={9-DIGIT-PAN}`

### Example Request
```bash
curl -X GET "https://your-project.vercel.app/api/pan?pan=122782196"
```

### Example Response
```json
{
  "success": true,
  "pan": "122782196",
  "data": {
    "panDetails": [
      {
        "pan": "122782196",
        "trade_Name_Eng": "MUKTINATH ENTERPRISES",
        "trade_Name_Nep": "मुक्तिनाथ इन्टरप्राइजेज",
        "office_Name": "आन्तरिक राजस्व कार्यालय भद्रपुर",
        "vdc_Town": "कन्काई, नगरपालिका",
        "street_Name": "दुर्गापुर",
        "ward_No": "7",
        "eff_Reg_Date": "2079.09.25",
        "account_Status": "A"
      }
    ],
    "panTaxClearance": [
      {
        "fiscal_Year": "2081.082",
        "return_Verified_Date": "2082.08.03",
        "exists_Yn": "Y"
      }
    ],
    "panRegistrationDetail": [
      {
        "acctType": 10,
        "filing_Period": "Y",
        "accountStatus": "A"
      },
      {
        "acctType": 0,
        "filing_Period": "M",
        "accountStatus": "A"
      }
    ]
  },
  "source": "IRD Nepal Official Portal"
}
```

---

## Integration with Laravel / AforAudit Backend

Add to your `.env`:
```env
IRD_VERIFIER_SERVICE_URL=https://your-project.vercel.app/api/pan
```

In your Laravel Service:
```php
$response = Http::timeout(10)->get(env('IRD_VERIFIER_SERVICE_URL'), [
    'pan' => $pan
]);

if ($response->successful()) {
    $data = $response->json('data');
    // Process authentic IRD taxpayer details...
}
```

---

## License
MIT
