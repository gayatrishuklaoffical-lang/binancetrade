require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Binance = require('binance-api-node').default;
const logger = require('./logger');

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Initialize Telegram Bot
const telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Initialize Binance Client for LIVE FUTURES TRADING
const binanceClient = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
  futures: true
});

// Track active position
let activePosition = null;

// Parse signal from Telegram message
function parseSignal(message) {
  try {
    const text = message.text;
    
    // Check if it's a LONG signal
    if (!text.includes('🟢 LONG SIGNAL')) {
      return null;
    }

    // Extract symbol
    const symbolMatch = text.match(/LONG SIGNAL - (\w+)/);
    if (!symbolMatch) return null;
    const symbol = symbolMatch[1];

    // Extract entry price
    const entryMatch = text.match(/Entry:\s*([\d.]+)/);
    if (!entryMatch) return null;
    const entry = parseFloat(entryMatch[1]);

    // Extract take profit
    const tpMatch = text.match(/TP:\s*([\d.]+)/);
    if (!tpMatch) return null;
    const takeProfit = parseFloat(tpMatch[1]);

    // Extract leverage
    const leverageMatch = text.match(/Leverage:\s*(\d+)x/);
    const leverage = leverageMatch ? parseInt(leverageMatch[1]) : 3;

    // Extract margin
    const marginMatch = text.match(/Margin:\s*\$?([\d.]+)/);
    const margin = marginMatch ? parseFloat(marginMatch[1]) : 5;

    return {
      symbol,
      entry,
      takeProfit,
      leverage,
      margin,
      side: 'LONG'
    };
  } catch (error) {
    logger.error('Error parsing signal:', error);
    return null;
  }
}

// Calculate position size
async function calculatePositionSize(symbol, margin, leverage, entryPrice) {
  try {
    // Position size in base currency
    const notionalValue = margin * leverage;
    const quantity = notionalValue / entryPrice;
    
    // Get symbol info to round to correct precision
    const exchangeInfo = await binanceClient.futuresExchangeInfo();
    const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
    
    if (!symbolInfo) {
      throw new Error(`Symbol ${symbol} not found`);
    }

    const stepSize = parseFloat(
      symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize
    );
    
    const precision = stepSize.toString().split('.')[1]?.length || 0;
    const roundedQuantity = parseFloat(quantity.toFixed(precision));
    
    return roundedQuantity;
  } catch (error) {
    logger.error('Error calculating position size:', error);
    throw error;
  }
}

// Place order on Binance
async function placeOrder(signal) {
  try {
    logger.info('Placing order:', signal);

    // Set leverage
    await binanceClient.futuresLeverage({
      symbol: signal.symbol,
      leverage: signal.leverage
    });

    // Set margin type to ISOLATED
    try {
      await binanceClient.futuresMarginType({
        symbol: signal.symbol,
        marginType: 'ISOLATED'
      });
    } catch (e) {
      // Ignore if already set
      logger.info('Margin type already set or error:', e.message);
    }

    // Calculate quantity
    const quantity = await calculatePositionSize(
      signal.symbol,
      signal.margin,
      signal.leverage,
      signal.entry
    );

    logger.info(`Calculated quantity: ${quantity}`);

    // Place market entry order
    const entryOrder = await binanceClient.futuresOrder({
      symbol: signal.symbol,
      side: 'BUY',
      type: 'MARKET',
      quantity: quantity
    });

    logger.info('Entry order placed:', entryOrder);

    // Place take profit order (NO STOP LOSS)
    const tpOrder = await binanceClient.futuresOrder({
      symbol: signal.symbol,
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: signal.takeProfit,
      closePosition: true
    });

    logger.info('Take profit order placed:', tpOrder);

    // Store active position
    activePosition = {
      symbol: signal.symbol,
      entryOrderId: entryOrder.orderId,
      tpOrderId: tpOrder.orderId,
      quantity: quantity,
      entryPrice: signal.entry,
      takeProfit: signal.takeProfit,
      timestamp: Date.now()
    };

    return {
      success: true,
      entryOrder,
      tpOrder
    };
  } catch (error) {
    logger.error('Error placing order:', error);
    throw error;
  }
}

// Monitor position status
async function monitorPosition() {
  if (!activePosition) return;

  try {
    const positions = await binanceClient.futuresPositionRisk({
      symbol: activePosition.symbol
    });

    const position = positions.find(p => p.symbol === activePosition.symbol);

    if (position && parseFloat(position.positionAmt) === 0) {
      logger.info('Position closed:', activePosition.symbol);
      
      // Send notification
      telegramBot.sendMessage(
        TELEGRAM_CHAT_ID,
        `✅ Trade Closed: ${activePosition.symbol}\n` +
        `Entry: ${activePosition.entryPrice}\n` +
        `Exit: ${activePosition.takeProfit}\n` +
        `Quantity: ${activePosition.quantity}`
      );

      activePosition = null;
    }
  } catch (error) {
    logger.error('Error monitoring position:', error);
  }
}

// Handle Telegram messages
telegramBot.on('message', async (msg) => {
  try {
    // Only process messages from configured chat
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) {
      return;
    }

    // Check if there's already an active position
    if (activePosition) {
      logger.info('Active position exists, ignoring new signal');
      return;
    }

    // Parse signal
    const signal = parseSignal(msg);
    if (!signal) {
      return; // Not a valid signal
    }

    logger.info('Valid signal detected:', signal);

    // Place order
    const result = await placeOrder(signal);

    if (result.success) {
      telegramBot.sendMessage(
        TELEGRAM_CHAT_ID,
        `✅ Trade Executed!\n\n` +
        `Symbol: ${signal.symbol}\n` +
        `Side: LONG\n` +
        `Entry: ${signal.entry}\n` +
        `Take Profit: ${signal.takeProfit}\n` +
        `Leverage: ${signal.leverage}x\n` +
        `Margin: $${signal.margin}\n\n` +
        `⚠️ NO STOP LOSS - Only TP active`
      );
    }
  } catch (error) {
    logger.error('Error handling message:', error);
    telegramBot.sendMessage(
      TELEGRAM_CHAT_ID,
      `❌ Error: ${error.message}`
    );
  }
});

// Monitor positions every 10 seconds
setInterval(monitorPosition, 10000);

// Start bot
logger.info('🚀 Bot started - LIVE TRADING MODE');
logger.info('⚠️ Trading on Binance Futures Mainnet');
console.log('🤖 Bot is running - LIVE TRADING MODE');
console.log('⚠️ WARNING: Trading with REAL MONEY on Binance Futures');
console.log(`📱 Monitoring chat: ${TELEGRAM_CHAT_ID}`);
console.log('🚫 NO STOP LOSS - Only Take Profit orders';
