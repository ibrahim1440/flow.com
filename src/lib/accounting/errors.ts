export class AccountingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AccountingError";
    this.status = status;
  }
}
