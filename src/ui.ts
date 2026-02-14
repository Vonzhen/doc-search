import { AuthLevel } from "./auth"; 

export const html = (authLevel: AuthLevel) => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>图纸文档索引</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/alpinejs/3.13.5/cdn.min.js" defer></script>
</head>
<body class="bg-gray-50 min-h-screen p-6" x-data="app()">

    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-2xl font-bold text-gray-800">📄 图纸文档索引</h1>
            <div class="text-sm text-gray-500">
                当前权限: <span class="font-mono font-bold" x-text="authLabel"></span>
                <button x-show="authLevel > 0" @click="logout" class="ml-4 text-red-500 hover:underline">退出</button>
            </div>
        </div>

        <div x-show="authLevel === 0" class="bg-white p-8 rounded-lg shadow-md max-w-md mx-auto mt-20">
            <h2 class="text-lg font-semibold mb-4">访问受限</h2>
            <p class="text-gray-600 mb-4 text-sm">请输入团队口令或管理员口令。</p>
            <input type="password" x-model="password" @keyup.enter="login" placeholder="输入口令..." class="w-full p-2 border rounded mb-4">
            <button @click="login" class="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700">进入系统</button>
            <p x-show="loginError" class="text-red-500 text-sm mt-2 text-center">口令错误</p>
        </div>

        <div x-show="authLevel > 0" style="display: none;">
            
            <div x-show="authLevel === 2" class="bg-white p-6 rounded-lg shadow mb-6 border-l-4 border-green-500">
                <h3 class="font-bold mb-4">📤 上传新文档</h3>
                <div class="flex gap-4 items-end">
                    <div class="flex-1">
                        <label class="block text-sm text-gray-600 mb-1">选择文档</label>
                        <input type="file" x-ref="fileInput" class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"/>
                    </div>
                    <div class="flex-1">
                        <label class="block text-sm text-gray-600 mb-1">标签 (空格分隔)</label>
                        <input type="text" x-model="uploadTags" placeholder="例如: 2024 发票 报销" class="w-full p-2 border rounded">
                    </div>
                    <button @click="upload" class="bg-green-600 text-white px-6 py-2 rounded hover:bg-green-700" :disabled="isUploading">
                        <span x-text="isUploading ? '上传中...' : '上传'"></span>
                    </button>
                </div>
            </div>

            <div class="bg-white p-6 rounded-lg shadow">
                <div class="mb-6">
                    <input type="text" x-model="searchQuery" @input.debounce.500ms="search" placeholder="🔍 搜索文件名或标签..." class="w-full p-3 border rounded-lg text-lg focus:ring-2 focus:ring-blue-500 outline-none">
                </div>

                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-gray-100 text-gray-600 text-sm">
                                <th class="p-3">文件名</th>
                                <th class="p-3">标签</th>
                                <th class="p-3">大小</th>
                                <th class="p-3">日期</th>
                                <th class="p-3 text-right w-40">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            <template x-for="file in files" :key="file.id">
                                <tr class="border-b hover:bg-gray-50">
                                    <td class="p-3 font-medium text-gray-800" x-text="file.filename"></td>
                                    <td class="p-3">
                                        <div class="flex gap-1 flex-wrap">
                                            <template x-for="tag in (file.tags || [])">
                                                <span class="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded" x-text="tag"></span>
                                            </template>
                                        </div>
                                    </td>
                                    <td class="p-3 text-sm text-gray-500" x-text="(file.size / 1024 / 1024).toFixed(2) + ' MB'"></td>
                                    <td class="p-3 text-sm text-gray-500" x-text="new Date(file.created_at).toLocaleDateString()"></td>
                                    <td class="p-3 text-right space-x-2">
                                        <a :href="'/api/file/' + file.id" target="_blank" class="text-blue-600 hover:underline">预览</a>
                                        <button x-show="authLevel === 2" @click="openEditModal(file)" class="text-indigo-500 hover:text-indigo-700 text-sm">标签</button>
                                        <button x-show="authLevel === 2" @click="deleteFile(file.id)" class="text-red-500 hover:text-red-700 text-sm">删除</button>
                                    </td>
                                </tr>
                            </template>
                            <tr x-show="files.length === 0" class="text-center text-gray-500">
                                <td colspan="5" class="p-8">没有找到文件，试着搜一下？</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <div x-show="editModalOpen" style="display: none;" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div class="bg-white p-6 rounded-lg shadow-lg w-96 max-w-[90%]">
                <h3 class="text-lg font-bold mb-4 text-gray-800">编辑文件标签</h3>
                <p class="text-sm text-gray-500 mb-2 truncate" x-text="editingFileName"></p>
                <input type="text" x-model="editTagsInput" @keyup.enter="saveTags" placeholder="多个标签用空格分隔" class="w-full p-2 border rounded focus:ring-2 focus:ring-blue-500 outline-none mb-6">
                <div class="flex justify-end gap-3">
                    <button @click="closeEditModal" class="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded">取消</button>
                    <button @click="saveTags" class="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700" :disabled="isSavingTags">
                        <span x-text="isSavingTags ? '保存中...' : '保存'"></span>
                    </button>
                </div>
            </div>
        </div>

    </div>

    <script>
        function app() {
            return {
                authLevel: ${authLevel},
                password: '',
                loginError: false,
                searchQuery: '',
                files: [],
                uploadTags: '',
                isUploading: false,

                // 编辑标签相关状态
                editModalOpen: false,
                editingFileId: null,
                editingFileName: '',
                editTagsInput: '',
                isSavingTags: false,

                get authLabel() {
                    if (this.authLevel === 2) return '管理员 (Admin)';
                    if (this.authLevel === 1) return '团队成员 (Team)';
                    return '访客 (Guest)';
                },

                async init() {
                    if (this.authLevel > 0) {
                        this.search();
                    }
                },

                async login() {
                    const res = await fetch('/api/login', {
                        method: 'POST',
                        body: JSON.stringify({ password: this.password })
                    });
                    if (res.ok) {
                        window.location.reload();
                    } else {
                        this.loginError = true;
                    }
                },

                async logout() {
                    await fetch('/api/logout', { method: 'POST' });
                    window.location.reload();
                },

                async search() {
                    const res = await fetch('/api/search?q=' + this.searchQuery);
                    if (res.ok) {
                        this.files = await res.json();
                    }
                },

                async upload() {
                    const fileInput = this.$refs.fileInput;
                    if (!fileInput.files.length) return alert('请选择文件');
                    
                    this.isUploading = true;
                    const formData = new FormData();
                    formData.append('file', fileInput.files[0]);
                    formData.append('tags', this.uploadTags);

                    const res = await fetch('/api/upload', {
                        method: 'POST',
                        body: formData
                    });

                    if (res.ok) {
                        alert('上传成功');
                        fileInput.value = '';
                        this.uploadTags = '';
                        this.search();
                    } else {
                        alert('上传失败');
                    }
                    this.isUploading = false;
                },

                async deleteFile(id) {
                    if(!confirm('确定要删除吗？')) return;
                    const res = await fetch('/api/file/' + id, { method: 'DELETE' });
                    if (res.ok) this.search();
                },

                // 打开编辑弹窗
                openEditModal(file) {
                    this.editingFileId = file.id;
                    this.editingFileName = file.filename;
                    // 将数组转化为以空格分隔的字符串
                    this.editTagsInput = (file.tags || []).join(' ');
                    this.editModalOpen = true;
                },

                // 关闭编辑弹窗
                closeEditModal() {
                    this.editModalOpen = false;
                    this.editingFileId = null;
                    this.editingFileName = '';
                    this.editTagsInput = '';
                },

                // 保存标签逻辑
                async saveTags() {
                    if (!this.editingFileId) return;
                    
                    this.isSavingTags = true;
                    // 将空格分隔的字符串重新分割为数组
                    const tagsArray = this.editTagsInput.split(/\\s+/).filter(t => t.length > 0);

                    try {
                        const res = await fetch('/api/file/' + this.editingFileId + '/tags', {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ tags: tagsArray })
                        });

                        if (res.ok) {
                            const data = await res.json();
                            // 局部刷新：直接在内存中更新数据列表
                            const index = this.files.findIndex(f => f.id === this.editingFileId);
                            if (index !== -1) {
                                this.files[index].tags = data.tags;
                            }
                            this.closeEditModal();
                        } else {
                            const err = await res.json();
                            alert('标签更新失败: ' + (err.error || '未知错误'));
                        }
                    } catch (e) {
                        alert('网络错误，无法更新标签');
                    } finally {
                        this.isSavingTags = false;
                    }
                }
            }
        }
    </script>
</body>
</html>
`;
