declare global {
    interface AsyncMock {
        [K: string]: AsyncMock | ((...args: any[]) => Promise<AsyncMock>);
    }
    
    const chrome: AsyncMock;
}

export {}
