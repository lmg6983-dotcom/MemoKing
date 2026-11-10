// 색인(_memoking/index.json) 만들기 — vault.js 가 화면을 멈추지 않게 이 작업 스레드에서 돌린다 (PC 의 desktop/index-worker.js 와 같은 일)
import { indexOutput } from '../../app/js/core/indexer.js';

onmessage = (e) => postMessage(indexOutput(e.data));
