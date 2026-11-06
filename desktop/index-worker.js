// 색인(_memoking/index.json) 만들기 — vault.js 가 메인 프로세스를 멈추지 않게 이 작업 스레드에서 돌린다
import { parentPort, workerData } from 'node:worker_threads';
import { indexOutput } from '../app/js/core/indexer.js';

parentPort.postMessage(indexOutput(workerData));
