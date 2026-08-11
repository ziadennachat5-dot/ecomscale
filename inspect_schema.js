const supabaseUrl = "https://wxfialbmyfkafobtkrde.supabase.co";
const supabaseKey = "sb_secret_FDOt0gbJvkvoK9JgdQ9xwQ_nl76oc0C";

async function run() {
    const res = await fetch(`${supabaseUrl}/rest/v1/`, {
        headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`
        }
    });
    const openapi = await res.json();

    if (openapi.definitions) {
        for (const [name, definition] of Object.entries(openapi.definitions)) {
            if (['order_items', 'shipments'].includes(name)) {
                console.log(`\nTable: ${name}`);
                console.log("Properties:", Object.keys(definition.properties ?? {}));
            }
        }
    }
}

run().catch(console.error);
