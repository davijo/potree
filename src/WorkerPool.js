
export class WorkerPool {
	constructor() {
		this.workers = {};
	}

	getWorker(url) {
		if (!this.workers[url]) {
			this.workers[url] = [];
		}

		if (this.workers[url].length === 0) {
			let worker = new Worker(url);
			this.workers[url].push(worker);
		}

		let worker = this.workers[url].pop();

		return worker;
	}

	returnWorker(url, worker) {
		if (this.workers[url]) {
			// In case there's still a worker out in the wild and dispose has been called
			this.workers[url].push(worker);
		} else {
			if (worker.terminate) {
				worker.terminate();
				worker = undefined;
			}
		}
	}

	dispose() {
		//console.log('WorkerPool: disposing', this.workers);
		
		let keys = [];
		for (let key in this.workers) {
			if (!this.workers.hasOwnProperty(key)) {
				continue;
			}
			keys.push(key);
		}
		//console.log('WorkerPool: keys', keys);
		
		for (let key of keys) {
			for (let worker of this.workers[key]) {
				//console.log('WorkerPool: terminating', worker);
				
				worker.terminate();
				worker = undefined;
			}
		}

		this.workers = {};
	}
};

//Potree.workerPool = new Potree.WorkerPool();

export default new WorkerPool();