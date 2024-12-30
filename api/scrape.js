const axios = require('axios');
const cheerio = require('cheerio');

const handler = async (req, res) => {
  console.log('Request received:', req.method);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: 'Username and password required'
      });
    }

    // Simple test request
    const response = await axios.get('https://iulms.edu.pk/login/index.php');
    const $ = cheerio.load(response.data);
    const title = $('title').text();

    return res.status(200).json({
      success: true,
      message: 'Connected successfully',
      title
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'Server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

module.exports = handler;

module.exports.config = {
  api: {
    bodyParser: true,
  },
};
