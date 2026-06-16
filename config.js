module.exports = {
  token: process.env.DISCORD_TOKEN,
  prefix: "!",
  afkTimeoutMinutes: 60,      // 45min alone + 15min after Allan joins
  aloneTimeoutMinutes: 45,    // how long someone can be alone before Allan joins
};
