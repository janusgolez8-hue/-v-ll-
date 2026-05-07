const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", c => {
  console.log(`Bot online as ${c.user.tag}`);
  c.user.setActivity("your server", { type: ActivityType.Watching });
});
client.login(process.env.DISCORD_BOT_TOKEN);
