const { Worker } = require('worker_threads');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ============================================
// PARAMETER GRID GENERATOR
// ============================================

class ParameterGrid {
  constructor(paramRanges) {
    this.paramRanges = paramRanges;
  }
  
  generate() {
    const keys = Object.keys(this.paramRanges);
    const combinations = this.cartesianProduct(keys.map(k => this.paramRanges[k]));
    
    return combinations.map(combo => {
      const params = {};
      keys.forEach((key, i) => {
        params[key] = combo[i];
      });
      return params;
    });
  }
  
  cartesianProduct(arrays) {
    return arrays.reduce((acc, array) => {
      return acc.flatMap(x => array.map(y => [...x, y]));
    }, [[]]);
  }
  
  getCount() {
    return Object.values(this.paramRanges).reduce((acc, arr) => acc * arr.length, 1);
  }
}

// ============================================
// WORKER POOL MANAGER
// ============================================

class WorkerPool {
  constructor(workerScript, maxWorkers = null) {
    this.workerScript = workerScript;
    this.maxWorkers = maxWorkers || os.cpus().length;
    this.workers = [];
    this.queue = [];
    this.results = [];
    this.activeWorkers = 0;
    this.completedTasks = 0;
    this.totalTasks = 0;
  }
  
  async run(tasks) {
    this.totalTasks = tasks.length;
    this.queue = [...tasks];
    this.results = [];
    this.completedTasks = 0;
    
    console.log(`Starting worker pool with ${this.maxWorkers} workers`);
    console.log(`Total tasks: ${this.totalTasks}\n`);
    
    return new Promise((resolve, reject) => {
      this.resolveAll = resolve;
      this.rejectAll = reject;
      
      // Start initial workers
      for (let i = 0; i < Math.min(this.maxWorkers, this.queue.length); i++) {
        this.startWorker();
      }
    });
  }
  
  startWorker() {
    if (this.queue.length === 0) {
      // Check if all workers are done
      if (this.activeWorkers === 0) {
        this.resolveAll(this.results);
      }
      return;
    }
    
    const task = this.queue.shift();
    this.activeWorkers++;
    
    const worker = new Worker(this.workerScript, {
      workerData: task
    });
    
    worker.on('message', (result) => {
      this.results.push(result);
      this.completedTasks++;
      
      // Progress update
      const progress = ((this.completedTasks / this.totalTasks) * 100).toFixed(1);
      process.stdout.write(`\rProgress: ${this.completedTasks}/${this.totalTasks} (${progress}%) | Active workers: ${this.activeWorkers}`);
      
      worker.terminate();
      this.activeWorkers--;
      
      // Start next task
      this.startWorker();
    });
    
    worker.on('error', (error) => {
      console.error(`\nWorker error:`, error);
      this.activeWorkers--;
      this.startWorker();
    });
    
    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`\nWorker stopped with exit code ${code}`);
      }
    });
  }
}

// ============================================
// OPTIMIZATION MANAGER
// ============================================

class OptimizationManager {
  constructor(config) {
    this.config = config;
  }
  
  async optimize() {
    console.log('='.repeat(70));
    console.log('PARAMETER OPTIMIZATION');
    console.log('='.repeat(70));
    console.log(`Symbol: ${this.config.symbol}`);
    console.log(`Interval: ${this.config.interval}`);
    console.log(`Date Range: ${this.config.startDate} to ${this.config.endDate}`);
    console.log('='.repeat(70));
    
    // Generate parameter grid
    const grid = new ParameterGrid(this.config.parameterRanges);
    const combinations = grid.generate();
    
    console.log(`\nTotal parameter combinations: ${combinations.length}`);
    console.log('Parameter ranges:');
    Object.entries(this.config.parameterRanges).forEach(([key, values]) => {
      console.log(`  ${key}: [${values.join(', ')}]`);
    });
    console.log();
    
    // Prepare tasks
    const tasks = combinations.map((params, index) => ({
      id: index,
      symbol: this.config.symbol,
      interval: this.config.interval,
      startDate: this.config.startDate,
      endDate: this.config.endDate,
      baseConfig: this.config.baseConfig,
      parameters: params
    }));
    
    // Run optimization in parallel
    const pool = new WorkerPool(
      path.join(__dirname, 'optimization_worker.js'),
      this.config.maxWorkers
    );
    
    const startTime = Date.now();
    const results = await pool.run(tasks);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`\n\nOptimization completed in ${duration}s\n`);
    
    // Analyze results
    return this.analyzeResults(results);
  }
  
  analyzeResults(results) {
    // Filter out failed backtests
    const validResults = results.filter(r => r.success && r.report.totalTrades > 0);
    
    if (validResults.length === 0) {
      console.error('No valid results found!');
      return null;
    }
    
    console.log(`Valid results: ${validResults.length}/${results.length}\n`);
    
    // Sort by different metrics
    const sortedByReturn = [...validResults].sort((a, b) => 
      parseFloat(b.report.totalReturn) - parseFloat(a.report.totalReturn)
    );
    
    const sortedByProfitFactor = [...validResults].filter(r => r.report.profitFactor !== 'N/A')
      .sort((a, b) => parseFloat(b.report.profitFactor) - parseFloat(a.report.profitFactor));
    
    const sortedBySharpe = [...validResults].sort((a, b) => 
      parseFloat(b.report.sharpeRatio) - parseFloat(a.report.sharpeRatio)
    );
    
    const sortedByWinRate = [...validResults].sort((a, b) => 
      parseFloat(b.report.winRate) - parseFloat(a.report.winRate)
    );
    
    // Calculate statistics
    const avgReturn = validResults.reduce((sum, r) => sum + parseFloat(r.report.totalReturn), 0) / validResults.length;
    const avgWinRate = validResults.reduce((sum, r) => sum + parseFloat(r.report.winRate), 0) / validResults.length;
    const avgTrades = validResults.reduce((sum, r) => sum + r.report.totalTrades, 0) / validResults.length;
    
    // Display top results
    console.log('='.repeat(70));
    console.log('TOP 10 RESULTS BY TOTAL RETURN');
    console.log('='.repeat(70));
    this.displayTopResults(sortedByReturn.slice(0, 10));
    
    console.log('\n' + '='.repeat(70));
    console.log('TOP 10 RESULTS BY PROFIT FACTOR');
    console.log('='.repeat(70));
    this.displayTopResults(sortedByProfitFactor.slice(0, 10));
    
    console.log('\n' + '='.repeat(70));
    console.log('TOP 10 RESULTS BY SHARPE RATIO');
    console.log('='.repeat(70));
    this.displayTopResults(sortedBySharpe.slice(0, 10));
    
    console.log('\n' + '='.repeat(70));
    console.log('OVERALL STATISTICS');
    console.log('='.repeat(70));
    console.log(`Average Return: ${avgReturn.toFixed(2)}%`);
    console.log(`Average Win Rate: ${avgWinRate.toFixed(2)}%`);
    console.log(`Average Trades: ${avgTrades.toFixed(0)}`);
    console.log(`Best Return: ${sortedByReturn[0].report.totalReturn}%`);
    console.log(`Worst Return: ${sortedByReturn[sortedByReturn.length - 1].report.totalReturn}%`);
    
    // Save results
    const resultsData = {
      config: this.config,
      summary: {
        totalCombinations: results.length,
        validResults: validResults.length,
        avgReturn: avgReturn.toFixed(2),
        avgWinRate: avgWinRate.toFixed(2),
        avgTrades: avgTrades.toFixed(0)
      },
      topByReturn: sortedByReturn.slice(0, 20),
      topByProfitFactor: sortedByProfitFactor.slice(0, 20),
      topBySharpe: sortedBySharpe.slice(0, 20),
      topByWinRate: sortedByWinRate.slice(0, 20),
      allResults: validResults
    };
    
    fs.writeFileSync('optimization_results.json', JSON.stringify(resultsData, null, 2));
    console.log('\n✓ Full results saved to optimization_results.json');
    
    // Save CSV
    this.saveResultsCSV(validResults);
    
    // Return best configuration
    return sortedByReturn[0];
  }
  
  displayTopResults(results) {
    results.forEach((result, index) => {
      console.log(`\n${index + 1}. Parameters: ${JSON.stringify(result.parameters)}`);
      console.log(`   Return: ${result.report.totalReturn}% | Win Rate: ${result.report.winRate}% | Trades: ${result.report.totalTrades}`);
      console.log(`   Profit Factor: ${result.report.profitFactor} | Sharpe: ${result.report.sharpeRatio} | Max DD: ${result.report.maxDrawdown}%`);
      console.log(`   Net P&L: $${result.report.netPnL} | Fees: $${result.report.totalFees}`);
    });
  }
  
  saveResultsCSV(results) {
    const paramKeys = Object.keys(results[0].parameters);
    const header = [
      ...paramKeys,
      'TotalReturn%',
      'WinRate%',
      'TotalTrades',
      'Wins',
      'Losses',
      'NetPnL',
      'GrossPnL',
      'TotalFees',
      'AvgWin',
      'AvgLoss',
      'ProfitFactor',
      'MaxDrawdown%',
      'SharpeRatio'
    ].join(',');
    
    const rows = results.map(r => {
      const paramValues = paramKeys.map(k => r.parameters[k]);
      return [
        ...paramValues,
        r.report.totalReturn,
        r.report.winRate,
        r.report.totalTrades,
        r.report.wins,
        r.report.losses,
        r.report.netPnL,
        r.report.grossPnL,
        r.report.totalFees,
        r.report.avgWin,
        r.report.avgLoss,
        r.report.profitFactor,
        r.report.maxDrawdown,
        r.report.sharpeRatio
      ].join(',');
    });
    
    const csv = [header, ...rows].join('\n');
    fs.writeFileSync('optimization_results.csv', csv);
    console.log('✓ Results table saved to optimization_results.csv');
  }
}

// ============================================
// MAIN EXECUTION
// ============================================

async function main() {
  const config = {
    // Data configuration
    symbol: 'BTCUSDT',
    interval: '2m',
    startDate: '2024-10-01',
    endDate: '2024-10-15',
    
    // Worker configuration
    maxWorkers: os.cpus().length, // Use all CPU cores
    
    // Base strategy configuration (fixed parameters)
    baseConfig: {
      initialCapital: 10000,
      riskPerTrade: 0.01,
      makerFee: 0.001,
      takerFee: 0.001,
      tradingHours: { start: 0, end: 24 },
      useDynamicBands: true,
      requireRsiDivergence: false,
      takeProfitTarget: 'middle'
    },
    
    // Parameter ranges to optimize (will test all combinations)
    parameterRanges: {
      // Standard Error Band parameters
      sebPeriod: [15, 20, 25],
      sebMultiplier: [1.5, 2.0, 2.5],
      
      // Regime filters
      adxThreshold: [20, 25, 30],
      maxBandAngle: [25, 30, 35],
      atrVolatilityThreshold: [1.3, 1.5, 1.7],
      
      // Entry filters
      minBandPenetration: [0.05, 0.1, 0.15],
      
      // Risk management
      stopLossMultiplier: [0.8, 1.0, 1.2],
      partialTakeProfit: [0.3, 0.5, 0.7],
      
      // Trailing stop
      useTrailingStop: [true, false],
      trailingStopATRMultiplier: [0.3, 0.5, 0.7]
    }
  };
  
  // Calculate total combinations
  const totalCombinations = Object.values(config.parameterRanges)
    .reduce((acc, arr) => acc * arr.length, 1);
  
  console.log(`\nThis will test ${totalCombinations} parameter combinations`);
  console.log(`Using ${config.maxWorkers} parallel workers`);
  console.log(`Estimated time: ~${(totalCombinations / config.maxWorkers * 2).toFixed(0)} seconds\n`);
  
  // Check if user wants to proceed
  if (totalCombinations > 1000) {
    console.log('⚠️  WARNING: Large number of combinations may take significant time!');
    console.log('Consider reducing parameter ranges for faster results.\n');
  }
  
  const optimizer = new OptimizationManager(config);
  const bestResult = await optimizer.optimize();
  
  if (bestResult) {
    console.log('\n' + '='.repeat(70));
    console.log('RECOMMENDED CONFIGURATION');
    console.log('='.repeat(70));
    console.log(JSON.stringify(bestResult.parameters, null, 2));
    console.log('\nExpected Performance:');
    console.log(`  Total Return: ${bestResult.report.totalReturn}%`);
    console.log(`  Win Rate: ${bestResult.report.winRate}%`);
    console.log(`  Profit Factor: ${bestResult.report.profitFactor}`);
    console.log(`  Max Drawdown: ${bestResult.report.maxDrawdown}%`);
    console.log(`  Sharpe Ratio: ${bestResult.report.sharpeRatio}`);
    console.log('='.repeat(70));
  }
}

// Run optimization
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { OptimizationManager, ParameterGrid, WorkerPool };