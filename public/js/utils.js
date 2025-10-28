/**
 * KYX API Refueling Station - 工具函数模块
 */

// Toast 消息提示
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  const bgColor = type === 'success' ? 'bg-gradient-to-r from-green-500 to-emerald-600' : 'bg-gradient-to-r from-red-500 to-pink-600';
  toast.className = `toast px-6 py-4 rounded-xl ${bgColor} text-white min-w-[300px]`;
  toast.innerHTML = `
    <div class="flex items-center gap-3">
      <div class="flex-shrink-0 w-6 h-6 rounded-full ${type === 'success' ? 'bg-white/20' : 'bg-white/20'} flex items-center justify-center">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          ${type === 'success' ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>' : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>'}
        </svg>
      </div>
      <span class="font-medium">${message}</span>
    </div>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// 感谢投喂的特殊 Toast
function showThankYouToast() {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'fixed top-24 left-1/2 transform -translate-x-1/2 z-[10000] px-12 py-10 rounded-3xl bg-gradient-to-r from-purple-600 via-pink-600 to-red-600 text-white shadow-2xl';
  toast.style.animation = 'fadeInScale 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55)';
  toast.innerHTML = `
    <div class="relative">
      <!-- 粒子容器 -->
      <div class="absolute inset-0 overflow-hidden rounded-3xl pointer-events-none" style="z-index: 0;">
        ${Array.from({length: 25}, (_, i) => `
          <div class="particle absolute w-1.5 h-1.5 bg-white rounded-full" style="
            left: ${Math.random() * 100}%;
            top: ${Math.random() * 100}%;
            opacity: ${0.15 + Math.random() * 0.2};
            animation: float ${2 + Math.random() * 3}s ease-in-out infinite;
            animation-delay: ${Math.random() * 2}s;
          "></div>
        `).join('')}
      </div>
      
      <!-- 内容 -->
      <div class="relative text-center" style="z-index: 10;">
        <div class="text-6xl mb-4 animate-bounce">🎉</div>
        <div class="text-3xl font-bold mb-3 drop-shadow-lg">感谢您的支持！</div>
        <div class="text-lg opacity-95 mb-2 drop-shadow-md">您的投喂让公益站更好运行</div>
        <div class="flex items-center justify-center gap-2 text-sm opacity-90 drop-shadow-md">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/>
          </svg>
          <span>公益有你，未来可期</span>
        </div>
      </div>
    </div>
  `;
  
  // 添加动画样式
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeInScale {
      from {
        opacity: 0;
        transform: translate(-50%, -30px) scale(0.8);
      }
      to {
        opacity: 1;
        transform: translate(-50%, 0) scale(1);
      }
    }
    @keyframes fadeOutScale {
      from {
        opacity: 1;
        transform: translate(-50%, 0) scale(1);
      }
      to {
        opacity: 0;
        transform: translate(-50%, -30px) scale(0.8);
      }
    }
    @keyframes float {
      0%, 100% {
        transform: translateY(0) translateX(0);
      }
      25% {
        transform: translateY(-10px) translateX(5px);
      }
      50% {
        transform: translateY(-20px) translateX(-5px);
      }
      75% {
        transform: translateY(-10px) translateX(5px);
      }
    }
    .particle {
      pointer-events: none;
    }
  `;
  if (!document.querySelector('#thankYouToastStyle')) {
    style.id = 'thankYouToastStyle';
    document.head.appendChild(style);
  }
  
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'fadeOutScale 0.5s ease-in forwards';
    setTimeout(() => toast.remove(), 500);
  }, 4000);
}

// 显示消息
function showMessage(text, type, section = 'main') {
  const msgId = section === 'bind' ? 'bindMessage' : 'message';
  const msg = document.getElementById(msgId);
  msg.textContent = text;
  msg.className = `p-4 rounded-lg mb-4 ${type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`;
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 5000);
}

// 切换下拉菜单
function toggleDropdown() {
  document.getElementById('dropdownMenu').classList.toggle('hidden');
}

function toggleSlotDropdown() {
  document.getElementById('slotDropdownMenu').classList.toggle('hidden');
}

// 点击外部关闭下拉菜单
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('dropdownMenu');
  const slotDropdown = document.getElementById('slotDropdownMenu');
  
  if (dropdown && !e.target.closest('button[onclick="toggleDropdown()"]') && !dropdown.contains(e.target)) {
    dropdown.classList.add('hidden');
  }
  
  if (slotDropdown && !e.target.closest('button[onclick="toggleSlotDropdown()"]') && !slotDropdown.contains(e.target)) {
    slotDropdown.classList.add('hidden');
  }
});

// 格式化金额（聪转美元）
function formatQuota(quota) {
  return `$${(quota / 500000).toFixed(2)}`;
}

// 格式化日期
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// 格式化相对时间
function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}天前`;
  if (hours > 0) return `${hours}小时前`;
  if (minutes > 0) return `${minutes}分钟前`;
  return '刚刚';
}

// 防抖函数
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 节流函数
function throttle(func, limit) {
  let inThrottle;
  return function() {
    const args = arguments;
    const context = this;
    if (!inThrottle) {
      func.apply(context, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

// 复制到剪贴板
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板', 'success');
  } catch (err) {
    // 降级方案
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      showToast('已复制到剪贴板', 'success');
    } catch (e) {
      showToast('复制失败', 'error');
    }
    document.body.removeChild(textarea);
  }
}

// 获取查询参数
function getQueryParam(name) {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
}

// 加载状态管理
const loadingState = {
  count: 0,
  show() {
    this.count++;
    document.getElementById('loadingPage')?.classList.remove('hidden');
  },
  hide() {
    this.count = Math.max(0, this.count - 1);
    if (this.count === 0) {
      document.getElementById('loadingPage')?.classList.add('hidden');
    }
  }
};

