const { execFileSync } = require('child_process');

function getGpuStats() {
  try {
    const out = execFileSync('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 3000 });

    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [index, name, memTotal, memUsed, util, temp] = line.split(',').map((s) => s.trim());
      return {
        index: Number(index),
        name,
        memTotalMiB: Number(memTotal),
        memUsedMiB: Number(memUsed),
        utilPct: Number(util),
        tempC: Number(temp),
      };
    });
  } catch (err) {
    return [];
  }
}

module.exports = { getGpuStats };
