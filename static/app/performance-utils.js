export function createSectionInitializer(initializers = {}) {
    const initializedSections = new Set();

    async function ensureInitialized(sectionId) {
        const initializer = initializers[sectionId];
        if (!initializer || initializedSections.has(sectionId)) {
            return false;
        }

        initializedSections.add(sectionId);
        await initializer();
        return true;
    }

    function isInitialized(sectionId) {
        return initializedSections.has(sectionId);
    }

    return {
        ensureInitialized,
        isInitialized
    };
}

export function createDebouncedTask(task, wait = 250) {
    let timer = null;

    return (...args) => {
        if (timer) {
            clearTimeout(timer);
        }

        timer = setTimeout(() => {
            timer = null;
            task(...args);
        }, wait);
    };
}
