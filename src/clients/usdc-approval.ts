/**
 * USDC Approval Manager
 * Handles checking and setting USDC approvals for Polymarket contracts on Polygon
 */

import { ethers, Contract, Wallet, Provider, formatUnits, parseUnits } from 'ethers';
import type { Config } from '../types/index.js';
import logger from '../utils/logger.js';
import { formatCurrency } from '../utils/helpers.js';

// Contract addresses on Polygon Mainnet
const POLYGON_CONTRACTS = {
  // USDC.e (Bridged USDC from Ethereum) - commonly used on Polymarket
  USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  // Native USDC on Polygon
  USDC_NATIVE: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  // Polymarket CTF Exchange (Conditional Token Framework)
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  // Polymarket Neg Risk CTF Exchange
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  // Polymarket Neg Risk Adapter
  NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
};

// Contract addresses on Amoy Testnet
const AMOY_CONTRACTS = {
  USDC_E: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  USDC_NATIVE: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  CTF_EXCHANGE: '0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40',
  NEG_RISK_CTF_EXCHANGE: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  NEG_RISK_ADAPTER: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
};

// ERC20 ABI (only what we need)
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export interface ApprovalStatus {
  hasApproval: boolean;
  currentAllowance: number;
  requiredAllowance: number;
  usdcBalance: number;
  usdcContract: string;
  spenderContract: string;
  spenderName: string;
}

export interface ApprovalResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export class UsdcApprovalManager {
  private wallet: Wallet;
  private provider: Provider;
  private config: Config;
  private contracts: typeof POLYGON_CONTRACTS;
  private usdcContract: Contract | null = null;
  private decimals: number = 6;

  // Maximum approval amount (max uint256 for unlimited)
  private readonly MAX_APPROVAL = ethers.MaxUint256;
  // Minimum required allowance (in USDC, e.g., 10000 = $10,000)
  private readonly MIN_REQUIRED_ALLOWANCE = 10000;

  constructor(config: Config) {
    this.config = config;

    // Set up provider for Polygon
    const rpcUrl = config.chainId === 137
      ? 'https://polygon-rpc.com'
      : 'https://rpc-amoy.polygon.technology';

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(config.privateKey, this.provider);

    // Use appropriate contracts based on chain
    this.contracts = config.chainId === 137 ? POLYGON_CONTRACTS : AMOY_CONTRACTS;
  }

  /**
   * Initialize and detect which USDC contract has balance
   */
  public async initialize(): Promise<void> {
    logger.info('Initializing USDC approval manager', {
      chain: this.config.chainId === 137 ? 'Polygon Mainnet' : 'Amoy Testnet',
      wallet: this.wallet.address,
    });

    // Try USDC.e first (more commonly used on Polymarket)
    let usdcAddress = this.contracts.USDC_E;
    let contract = new Contract(usdcAddress, ERC20_ABI, this.wallet);

    try {
      const balance = await contract.balanceOf(this.wallet.address);
      const decimals = await contract.decimals();
      this.decimals = Number(decimals);

      if (balance > 0n) {
        this.usdcContract = contract;
        logger.info('Using USDC.e (bridged)', {
          address: usdcAddress,
          balance: formatCurrency(Number(formatUnits(balance, this.decimals))),
        });
        return;
      }
    } catch (error) {
      logger.debug('USDC.e check failed', { error: (error as Error).message });
    }

    // Try native USDC
    usdcAddress = this.contracts.USDC_NATIVE;
    contract = new Contract(usdcAddress, ERC20_ABI, this.wallet);

    try {
      const balance = await contract.balanceOf(this.wallet.address);
      const decimals = await contract.decimals();
      this.decimals = Number(decimals);
      this.usdcContract = contract;

      logger.info('Using native USDC', {
        address: usdcAddress,
        balance: formatCurrency(Number(formatUnits(balance, this.decimals))),
      });
    } catch (error) {
      logger.warn('Native USDC check failed, defaulting to USDC.e', {
        error: (error as Error).message,
      });
      this.usdcContract = new Contract(this.contracts.USDC_E, ERC20_ABI, this.wallet);
    }
  }

  /**
   * Check approval status for all required Polymarket contracts
   */
  public async checkAllApprovals(): Promise<{
    allApproved: boolean;
    statuses: ApprovalStatus[];
  }> {
    await this.ensureInitialized();

    const spenders = [
      { address: this.contracts.CTF_EXCHANGE, name: 'CTF Exchange' },
      { address: this.contracts.NEG_RISK_CTF_EXCHANGE, name: 'Neg Risk CTF Exchange' },
      { address: this.contracts.NEG_RISK_ADAPTER, name: 'Neg Risk Adapter' },
    ];

    const statuses: ApprovalStatus[] = [];
    let allApproved = true;

    const usdcAddress = await this.usdcContract!.getAddress();
    const balance = await this.usdcContract!.balanceOf(this.wallet.address);
    const usdcBalance = Number(formatUnits(balance, this.decimals));

    for (const spender of spenders) {
      const status = await this.checkApproval(spender.address, spender.name, usdcBalance);
      statuses.push(status);

      if (!status.hasApproval) {
        allApproved = false;
      }
    }

    return { allApproved, statuses };
  }

  /**
   * Check approval for a specific spender
   */
  public async checkApproval(
    spenderAddress: string,
    spenderName: string,
    usdcBalance?: number
  ): Promise<ApprovalStatus> {
    await this.ensureInitialized();

    const usdcAddress = await this.usdcContract!.getAddress();

    // Get current allowance
    const allowance = await this.usdcContract!.allowance(this.wallet.address, spenderAddress);
    const currentAllowance = Number(formatUnits(allowance, this.decimals));

    // Get balance if not provided
    if (usdcBalance === undefined) {
      const balance = await this.usdcContract!.balanceOf(this.wallet.address);
      usdcBalance = Number(formatUnits(balance, this.decimals));
    }

    // Consider approved if allowance is greater than minimum required
    const hasApproval = currentAllowance >= this.MIN_REQUIRED_ALLOWANCE;

    return {
      hasApproval,
      currentAllowance,
      requiredAllowance: this.MIN_REQUIRED_ALLOWANCE,
      usdcBalance,
      usdcContract: usdcAddress,
      spenderContract: spenderAddress,
      spenderName,
    };
  }

  /**
   * Approve USDC spending for a specific contract
   */
  public async approve(
    spenderAddress: string,
    amount?: bigint
  ): Promise<ApprovalResult> {
    await this.ensureInitialized();

    const approvalAmount = amount || this.MAX_APPROVAL;

    logger.info('Approving USDC spending', {
      spender: spenderAddress,
      amount: approvalAmount === this.MAX_APPROVAL ? 'unlimited' : formatUnits(approvalAmount, this.decimals),
    });

    try {
      // Estimate gas first
      const gasEstimate = await this.usdcContract!.approve.estimateGas(spenderAddress, approvalAmount);

      // Add 20% buffer to gas estimate
      const gasLimit = (gasEstimate * 120n) / 100n;

      // Get current gas price
      const feeData = await this.provider.getFeeData();

      // Send approval transaction
      const tx = await this.usdcContract!.approve(spenderAddress, approvalAmount, {
        gasLimit,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      });

      logger.info('Approval transaction sent', { txHash: tx.hash });

      // Wait for confirmation
      const receipt = await tx.wait();

      if (receipt.status === 1) {
        logger.info('Approval confirmed', {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
        });

        return { success: true, txHash: tx.hash };
      } else {
        return { success: false, error: 'Transaction reverted' };
      }

    } catch (error) {
      const errorMessage = (error as Error).message;
      logger.error('Approval failed', { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Approve all required Polymarket contracts
   */
  public async approveAll(): Promise<{
    success: boolean;
    results: Array<{ spender: string; name: string; result: ApprovalResult }>;
  }> {
    await this.ensureInitialized();

    const spenders = [
      { address: this.contracts.CTF_EXCHANGE, name: 'CTF Exchange' },
      { address: this.contracts.NEG_RISK_CTF_EXCHANGE, name: 'Neg Risk CTF Exchange' },
      { address: this.contracts.NEG_RISK_ADAPTER, name: 'Neg Risk Adapter' },
    ];

    const results: Array<{ spender: string; name: string; result: ApprovalResult }> = [];
    let allSuccess = true;

    for (const spender of spenders) {
      // Check if already approved
      const status = await this.checkApproval(spender.address, spender.name);

      if (status.hasApproval) {
        logger.info(`${spender.name} already approved`, {
          currentAllowance: formatCurrency(status.currentAllowance),
        });
        results.push({
          spender: spender.address,
          name: spender.name,
          result: { success: true },
        });
        continue;
      }

      // Approve
      logger.info(`Approving ${spender.name}...`);
      const result = await this.approve(spender.address);
      results.push({
        spender: spender.address,
        name: spender.name,
        result,
      });

      if (!result.success) {
        allSuccess = false;
      }

      // Wait a bit between approvals to avoid nonce issues
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return { success: allSuccess, results };
  }

  /**
   * Get USDC balance
   */
  public async getBalance(): Promise<number> {
    await this.ensureInitialized();

    const balance = await this.usdcContract!.balanceOf(this.wallet.address);
    return Number(formatUnits(balance, this.decimals));
  }

  /**
   * Get MATIC balance for gas
   */
  public async getMaticBalance(): Promise<number> {
    const balance = await this.provider.getBalance(this.wallet.address);
    return Number(formatUnits(balance, 18));
  }

  /**
   * Ensure the manager is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.usdcContract) {
      await this.initialize();
    }
  }

  /**
   * Get contract addresses being used
   */
  public getContractAddresses(): typeof POLYGON_CONTRACTS {
    return this.contracts;
  }
}

/**
 * Run approval check and prompt user if needed
 */
export async function checkAndApproveUsdc(
  config: Config,
  autoApprove: boolean = false
): Promise<{ approved: boolean; balance: number }> {
  const manager = new UsdcApprovalManager(config);
  await manager.initialize();

  // Check MATIC balance for gas
  const maticBalance = await manager.getMaticBalance();
  if (maticBalance < 0.1) {
    logger.warn('Low MATIC balance for gas fees', {
      balance: maticBalance.toFixed(4),
      recommended: '0.1+ MATIC',
    });
  }

  // Check USDC balance
  const usdcBalance = await manager.getBalance();
  logger.info('USDC balance', { balance: formatCurrency(usdcBalance) });

  if (usdcBalance < 10) {
    logger.error('Insufficient USDC balance', {
      balance: formatCurrency(usdcBalance),
      minimum: formatCurrency(10),
    });
    return { approved: false, balance: usdcBalance };
  }

  // Check all approvals
  const { allApproved, statuses } = await manager.checkAllApprovals();

  // Log status for each contract
  for (const status of statuses) {
    if (status.hasApproval) {
      logger.info(`${status.spenderName}: Approved`, {
        allowance: formatCurrency(status.currentAllowance),
      });
    } else {
      logger.warn(`${status.spenderName}: Not approved`, {
        allowance: formatCurrency(status.currentAllowance),
        required: formatCurrency(status.requiredAllowance),
      });
    }
  }

  if (allApproved) {
    logger.info('All USDC approvals are in place');
    return { approved: true, balance: usdcBalance };
  }

  // Need to approve
  if (!autoApprove) {
    logger.info('USDC approvals needed. Run with --auto-approve or set AUTO_APPROVE=true in .env');
    return { approved: false, balance: usdcBalance };
  }

  // Auto-approve
  logger.info('Auto-approving USDC for Polymarket contracts...');
  const { success, results } = await manager.approveAll();

  for (const { name, result } of results) {
    if (result.success) {
      logger.info(`${name}: Approval successful`, { txHash: result.txHash });
    } else {
      logger.error(`${name}: Approval failed`, { error: result.error });
    }
  }

  return { approved: success, balance: usdcBalance };
}

export default UsdcApprovalManager;
