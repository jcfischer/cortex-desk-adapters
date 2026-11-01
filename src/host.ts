export const HOST_LABELS = "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}";

export const HOST = new RegExp(`^${HOST_LABELS}$`);
