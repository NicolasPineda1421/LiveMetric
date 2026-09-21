require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`[voting-service] escuchando en puerto ${PORT}`));
