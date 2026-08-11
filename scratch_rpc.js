const supabaseUrl = "https://wxfialbmyfkafobtkrde.supabase.co";
const supabaseKey = "sb_secret_FDOt0gbJvkvoK9JgdQ9xwQ_nl76oc0C"; // service role key

const headers = {
  "apikey": supabaseKey,
  "Authorization": `Bearer ${supabaseKey}`
};

async function run() {
  const res = await fetch(`${supabaseUrl}/rest/v1/`, { headers });
  if (!res.ok) {
    console.error("Failed to fetch API spec:", await res.text());
    return;
  }
  const spec = await res.json();
  console.log("Available paths/endpoints:");
  console.log(Object.keys(spec.paths).filter(p => p.startsWith("/rpc/")));
}

run().catch(console.error);
