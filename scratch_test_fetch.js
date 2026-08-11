const supabaseUrl = "https://wxfialbmyfkafobtkrde.supabase.co";
const supabaseKey = "sb_secret_FDOt0gbJvkvoK9JgdQ9xwQ_nl76oc0C"; // service role key

const headers = {
  "apikey": supabaseKey,
  "Authorization": `Bearer ${supabaseKey}`
};

async function run() {
  console.log("Testing campaign join query...");
  const res = await fetch(`${supabaseUrl}/rest/v1/orders?select=*,campaign:campaigns(*)&order=created_at.desc&limit=5`, {
    headers
  });
  console.log("Status:", res.status);
  console.log("Response:", await res.text());
}

run().catch(console.error);
