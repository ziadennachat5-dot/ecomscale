const supabaseUrl = "https://wxfialbmyfkafobtkrde.supabase.co";
const supabaseKey = "sb_secret_FDOt0gbJvkvoK9JgdQ9xwQ_nl76oc0C"; // service role key

const headers = {
  "apikey": supabaseKey,
  "Authorization": `Bearer ${supabaseKey}`,
  "Content-Type": "application/json",
  "Prefer": "return=representation"
};

async function run() {
  console.log("Trying to insert dummy order with new columns...");
  const payload = {
    order_number: "#GS-TEST-COLUMNS",
    status: "pending",
    total: 100,
    phone: "123456789",
    variant_price: 100,
    sku: "TEST-SKU",
    customer_ip: "127.0.0.1",
    product_variant: "TEST-VARIANT"
  };
  const res = await fetch(`${supabaseUrl}/rest/v1/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  console.log("Status:", res.status);
  console.log("Response:", await res.text());
}

run().catch(console.error);
