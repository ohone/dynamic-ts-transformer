declare global {
    interface AsyncMock {
        [K: string]: Promise<AsyncMock> | ((...args: any[]) => Promise<AsyncMock>);
    }
    
    const chrome: AsyncMock;
}

export {}
